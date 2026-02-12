# doctree-mcp — Architecture & Design

## Standing on the Shoulders of Giants

This project is a synthesis of ideas from three excellent projects. None
of the core architectural concepts are original — the value is in the
specific composition that makes them work together for **agentic document
retrieval** over markdown repositories.

Every design decision is attributed to its source. If you're reading this
document, you should go read the originals too:

| Source | What we took | Link |
|--------|-------------|------|
| **PageIndex** | Hierarchical tree navigation, agent reasoning workflow | [pageindex.ai](https://pageindex.ai) |
| **Pagefind** (CloudCannon) | BM25 scoring, positional index, filter facets, density excerpts, content hashing, multisite, weighting, stemming | [pagefind.app](https://pagefind.app) |
| **Bun.markdown** (Oven) | Native CommonMark parser with render callbacks | [bun.sh](https://bun.sh/blog/bun-v1.3.8) |
| **Astro Starlight** | The documentation framework whose Pagefind integration prompted this investigation | [starlight.astro.build](https://starlight.astro.build) |

---

### 1. PageIndex — Tree Navigation & Agent Reasoning

**Source:** [pageindex.ai](https://pageindex.ai) — _"Hierarchical Page-level
Index for Information Retrieval"_ by Gao et al.

**What we took:**

- The hierarchical tree model where documents are decomposed into nested
  sections (nodes) by heading level
- The insight that **the LLM itself is the retrieval engine** — the agent
  reads a structural outline and reasons about which branches to explore,
  rather than relying on vector similarity scores to decide relevance
- The 5-tool MCP interface pattern: catalog → search → tree → node → subtree
- The agent reasoning workflow: search to find candidates, read tree structure
  to reason about relevance, retrieve specific sections
- The compact `TreeOutline` representation (no content, just structure + word
  counts) that serves as the agent's "table of contents"

**What PageIndex does differently:**

- PageIndex targets PDF documents, using GPT-4o to construct the tree from
  parsed PDF pages. We skip this entirely because markdown headings give us
  the tree structure for free.
- PageIndex achieves 98.7% accuracy on FinanceBench by having the LLM
  iteratively navigate the tree. Our design follows the same navigation
  pattern but starts from a much cheaper index (zero LLM calls at indexing).

---

### 2. Pagefind — The Search Engine That Taught Us Everything

**Source:** [pagefind.app](https://pagefind.app) — by
[CloudCannon](https://cloudcannon.com). Written in Rust. Used as the
default search engine in **Astro Starlight**
([starlight.astro.build](https://starlight.astro.build)), one of the
most popular documentation frameworks.

Pagefind is the single biggest influence on our search layer. Nearly
every retrieval decision we made has a direct counterpart in Pagefind's
design. Here's the full accounting:

#### 2a. BM25 Ranking Alignment

**Pagefind:** v1.1+ aligned its scoring to the BM25 probabilistic ranking
function after finding that naive TF-IDF wasn't cutting it for
documentation sites. They also exposed configurable ranking parameters
because "certain categories of site (i.e. reference documentation) can
benefit from tweaks to the way pages are ranked."

**Our adaptation:** We adopted BM25 with the same formulation:
`IDF × saturated TF × length normalization`. We expose the same style of
knobs (`bm25_k1`, `bm25_b`, `title_weight`, `code_weight`,
`term_proximity_bonus`, `full_coverage_bonus`) via `setRanking()`.

**Why this matters for docs:** Documentation corpora have highly skewed
term distributions — technical terms appear in clusters, and BM25's
saturation curve handles this better than linear TF. A reference page
mentioning "authentication" 50 times shouldn't score 10× higher than
a focused section mentioning it 5 times.

#### 2b. Positional Inverted Index

**Pagefind:** Stores word positions per page and cross-references them
with heading anchors to build sub-results. Their data model:
`{ content, locations: number[], anchors: Anchor[],
weighted_locations: WeightedLocation[] }` — where `locations` are word
offsets into the flattened content, and `anchors` mark where headings
appear so you can determine which section each match falls in.

**Our adaptation:** Since our "pages" are already split into tree nodes
(sections), we store positions *within each node's token stream*. Our
`Posting` type has `{ doc_id, node_id, positions: number[],
term_frequency, weight }` — the `positions` array serves the same role
as Pagefind's `locations`, and the `weight` field mirrors Pagefind's
`weighted_locations` where heading text and body text get different scores.

#### 2c. Section-Aware Sub-Results

**Pagefind:** `sub_results` splits each page on headings (h1→h6) that
have `id` attributes that can be linked to. A maximum of three sub
results are shown per page, with sections having the most hits given
priority. The sub_results contain `title`, `url` (with fragment hash),
and `excerpt` scoped between that anchor and the next one.

**Our adaptation:** Our tree model takes this further — every section is
a first-class node with its own content, stats, and parent/child
relationships. Where Pagefind discovers section boundaries at search time
by cross-referencing `locations` with `anchors`, we know them at index
time because markdown headings give us the structure directly.

#### 2d. Density-Based Excerpt Generation

**Pagefind:** Picks the excerpt region with the highest density of
matching terms, rather than just centering on the first match.

**Our adaptation:** `buildDensitySnippet()` does the same: slides a
window across the node's word stream, counts how many match positions
fall in each window, and extracts the densest region.

#### 2e. Stemming at Index Time + Query Time

**Pagefind:** Stems words during indexing (in Rust) and also stems the
query, so searches for "configuring" match indexed "configuration."

**Our adaptation:** We apply the same pattern with a lightweight
Porter-style suffix stripper. Both the indexed terms and the query terms
are stemmed to the same root form.

#### 2f. Prefix Matching for Partial Terms

**Pagefind:** Loads index chunks based on the prefix of the search term,
enabling incremental search as users type. When Pagefind encounters
the search term `rebase`, it loads chunks for `rebas*` (after stemming)
rather than requiring exact matches.

**Our adaptation:** Our prefix matching is simpler (we iterate the
in-memory index) but follows the same idea: a search for "auth" matches
"authentication", "authorize", etc., scored at 50% of an exact match.

#### 2g. Filter Facets

**Pagefind:** Supports `data-pagefind-filter` attributes that associate
pages with filter keys and values. Filters are loaded as separate index
chunks on demand, enabling faceted navigation (e.g., filter by author,
category, date range). The Pagefind UI renders these as collapsible
filter panels.

**Our adaptation:** We extract filters from markdown frontmatter. Any
frontmatter key-value pair becomes a facet: `tags`, `category`, `status`,
`author`, `version` — whatever the document declares. The
`search_documents` tool accepts a `filters` parameter, and the
`list_documents` tool exposes available facets with value counts, so the
agent can narrow results the way a user would with Pagefind's filter UI.

This is more powerful for agentic use than Pagefind's HTML-attribute
approach because agents can reason over facets programmatically:
"There are 47 docs tagged 'api' and 12 tagged 'internal' — let me
filter to 'api' first."

#### 2h. Content Weighting

**Pagefind:** Supports `data-pagefind-weight` to boost the ranking
importance of specific page regions. Content within a weighted element
has its BM25 contribution multiplied by the weight value.

**Our adaptation:** We apply weighting at the structural level:
- Title text (heading content): `title_weight` (default 3.0)
- Code blocks: `code_weight` (default 1.5)
- Body text: 1.0
- Frontmatter description: `description_weight` (default 2.0)

Since our tree already knows what's a heading, what's code, and what's
prose, we don't need per-element annotation — the structure IS the
weight signal.

#### 2i. Content Hashing for Incremental Re-Indexing

**Pagefind:** Generates content-based fragment hashes so that unchanged
pages produce identical fragment filenames across builds. "If an HTML
page has not changed between two Pagefind indexes, the fragment filename
will not change." They also explored incremental indexing via "index
patches" — a small delta index loaded alongside the main one.

**Our adaptation:** We hash each file's content at index time using
`Bun.hash()` and store it as `content_hash` in `DocumentMeta`. On
re-index (via file watcher or explicit reload), we skip files whose
hash hasn't changed. For 900 files where only 5 changed, this turns
a 3-second re-index into a ~50ms operation.

#### 2j. Multi-Root / Multisite Search

**Pagefind:** Supports searching across multiple indexes from one
Pagefind instance, with per-index `indexWeight` to control how results
from different sites are ranked relative to each other. Filter values
can be automatically injected per-index via `mergeFilter`.

**Our adaptation:** We support multiple `DOCS_ROOT` directories, each
indexed as a separate "collection" with its own weight. The
`search_documents` tool can search across all collections or be scoped
to one. Each collection gets an automatic `collection` filter facet.

#### 2k. Custom Metadata

**Pagefind:** `data-pagefind-meta` captures structured metadata per page
(title, description, image, any custom key). This metadata is returned
in search results and can be used for display without loading the full
page content.

**Our adaptation:** We extract metadata from frontmatter and from the
document structure. The `search_documents` result includes all metadata,
so the agent can make retrieval decisions without loading full content.

#### 2l. Configurable Ranking Parameters

**Pagefind:** Exposes `pageWeight`, `termFrequency`, `termSaturation`,
`termSimilarity`, and `termBoost` as tunable parameters.

**Our adaptation:** We expose comparable knobs:

| Our Parameter | Pagefind Equivalent | Default | Purpose |
|---------------|-------------------|---------|---------|
| `bm25_k1` | `termSaturation` | 1.2 | TF saturation speed |
| `bm25_b` | (length norm factor) | 0.75 | Document length normalization |
| `title_weight` | (heading weight) | 3.0 | Heading match importance |
| `code_weight` | (custom weight) | 1.5 | Code block match importance |
| `description_weight` | (meta weight) | 2.0 | Description match importance |
| `term_proximity_bonus` | (multi-term) | 2.0 | Co-occurrence reward |
| `full_coverage_bonus` | (coverage) | 5.0 | All-terms-present reward |
| `prefix_penalty` | `termSimilarity` | 0.5 | Prefix match discount |

**What Pagefind does that we DON'T do (and why):**

- **Chunked index delivery over the wire.** Pagefind's killer feature is
  splitting the index into ~200 alphabetically ordered chunks, loaded via
  WASM in the browser with total payload <300KB for 10K pages. We're
  in-process, so we don't need this — but at 10K+ docs, Pagefind's
  chunking strategy would be the right model for a SQLite-backed variant.
- **WASM search runtime.** Pagefind compiles its search to WebAssembly
  for browser execution. We run natively in Bun.
- **HTML parsing.** Pagefind operates on built HTML. We operate on raw
  markdown, which is simpler and more direct.
- **Hierarchical tree navigation.** This is where we add value beyond
  Pagefind. Pagefind provides flat ranked results with optional
  sub-results. The tree-based reasoning is our contribution from PageIndex.

---

### 3. Bun.markdown — Native Parsing

**Source:** [bun.sh](https://bun.sh/blog/bun-v1.3.8) — Bun v1.3.8's
`Bun.markdown.render()` API. Built on a Zig-based CommonMark parser.

**What we took:**

- The `render()` callback API as a structural parser
- GFM extensions (tables, strikethrough, autolinks)
- Fallback to regex-based heading extraction when unavailable

**Why this completes the picture:**

- PageIndex needs GPT-4o to build trees from PDFs (expensive, slow, lossy)
- Pagefind needs to parse HTML after a full site build
- We parse raw markdown at native speed, getting the tree structure
  *before* any rendering step. For 900 files: 2-5 seconds, zero LLM calls.

---

### 4. Astro Starlight — The Prompt

**Source:** [starlight.astro.build](https://starlight.astro.build)

Starlight uses Pagefind as its default search engine. Investigating how
Starlight's search works led us to Pagefind, which led to the entire
search layer of this project.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                  MCP Server (stdio or HTTP)                       │
│                                                                   │
│  ┌──────────────┐  ┌───────────────┐  ┌───────────────────────┐  │
│  │ list_docs    │  │ search_docs   │  │ get_tree              │  │
│  │              │  │  (BM25)       │  │ get_node_content      │  │
│  │ Catalog +    │  │  Positional   │  │ navigate_tree         │  │
│  │ facet counts │  │  index        │  │                       │  │
│  │ pagination   │  │  stemming     │  │  Tree navigation      │  │
│  │ (Pagefind    │  │  prefix match │  │  (PageIndex-style)    │  │
│  │  filters)    │  │  facet filter │  │                       │  │
│  └──────┬───────┘  └──────┬────────┘  └──────────┬────────────┘  │
│         │                 │                       │               │
│         └─────────────────┼───────────────────────┘               │
│                           │                                       │
│              ┌────────────▼─────────────┐                         │
│              │   DocumentStore          │                         │
│              │                          │                         │
│              │  docs: Map<id, Doc>      │                         │
│              │  index: Map<term,        │                         │
│              │         Posting[]>       │                         │
│              │  filters: Map<key,       │  ← Pagefind filters    │
│              │       Map<val, Set>>     │                         │
│              │  hashes: Map<path, hash> │  ← Pagefind hashing    │
│              │  collections: Map<       │  ← Pagefind multisite  │
│              │    name, weight>         │                         │
│              │  ranking: BM25Params     │                         │
│              └────────────▲─────────────┘                         │
│                           │                                       │
│              ┌────────────┴─────────────┐                         │
│              │   Indexer                 │                         │
│              │  Bun.markdown.render()   │                         │
│              │  frontmatter → facets    │                         │
│              │  content hashing         │                         │
│              └────────────▲─────────────┘                         │
│                           │                                       │
└───────────────────────────┼───────────────────────────────────────┘
                            │
                   ┌────────┴────────┐
                   │  .md files      │
                   │  (multi-root)   │
                   └─────────────────┘
```

### Three Layers

1. **Indexer** (Bun.markdown) — Parses raw markdown into `IndexedDocument`
   objects with metadata, tree nodes, filter facets, and content hash.
   Zero LLM cost.

2. **Store** (BM25 + positional index + facets) — In-memory store with
   Pagefind-style keyword search and PageIndex-style tree navigation.
   Supports incremental re-indexing via content hashing.

3. **MCP Server** — Exposes 5 tools via `@modelcontextprotocol/sdk`.

---

## The Positional Inverted Index

*Inspired by Pagefind's index structure where each word maps to
page+position data. We adapt by making our "pages" tree nodes.*

### How It's Built

At load time, for each node in each document:

```
1. Tokenize the title → weighted at title_weight (3.0)
2. Tokenize the body → weighted at 1.0 (code blocks at code_weight 1.5)
3. Stem each token (Porter-style, same as Pagefind's Rust stemmer)
4. For each unique stemmed term, record positions + max weight
5. Store as Posting in the inverted index
6. Store node stats for BM25 length normalization
```

### How Search Works (BM25)

```
1. Tokenize + stem query terms
2. Look up postings for each term (exact + prefix match)
3. Compute BM25 score per posting: IDF × saturated TF × weight
4. Apply facet filters (reduce candidate set before scoring)
5. Apply co-occurrence bonuses (multi-term, full coverage)
6. Sort by score, generate density-based snippets
```

---

## Filter Facets

*Adapted from Pagefind's `data-pagefind-filter` system.*

### How Facets Are Built

At index time, for each document:
- Parse frontmatter YAML
- String values → single facet value
- Array values → multiple facet values
- Auto-facets: `collection` (from DOCS_ROOT), `has_code`, `depth`
- Store in FilterIndex: `key → value → Set<doc_id>`

### How Agents Use Facets

```
Step 1 — list_documents() → facet_counts: { category: { api: 120, guide: 85 } }
Step 2 — search_documents("auth", { filters: { category: "api" } })
Step 3 — Agent reasons and refines filters
```

---

## Content Hashing & Incremental Re-Indexing

*Inspired by Pagefind's stable fragment hashing.*

On re-index: hash file content → compare with stored hash → skip if
unchanged → surgically update inverted index if changed.

For 900 files with 5 changes: ~50ms vs ~3s full re-index.

---

## Multi-Root / Collection Support

*Adapted from Pagefind's multisite search with `indexWeight`.*

Multiple DOCS_ROOT directories, each as a named collection with a weight
multiplier. Search results are BM25-scored × collection weight. The
`collection` facet enables scoping.

---

## Agent Reasoning Workflow

*The key insight from PageIndex: the LLM is the retrieval engine.*

```
Step 1 — search_documents (Pagefind-style BM25 search with facets)
Step 2 — get_tree (PageIndex-style structural outline)
Step 3 — Agent reasons over the tree (PageIndex insight)
Step 4 — navigate_tree or get_node_content (precise retrieval)
Step 5 — Synthesize answer from structured, precise context
```

Context budget: 2K-8K tokens vs vector RAG's 4K-20K tokens.

---

## Scoring Tuning Guide

*Following Pagefind's philosophy of exposable ranking knobs.*

| Parameter | Default | Lower → | Higher → |
|-----------|---------|---------|----------|
| `bm25_k1` | 1.2 | TF saturates faster | TF matters more |
| `bm25_b` | 0.75 | Less length norm | More normalization |
| `title_weight` | 3.0 | Title matches count less | Title matches dominate |
| `code_weight` | 1.5 | Code matches count less | Code references promoted |
| `description_weight` | 2.0 | Description less important | Description promoted |
| `term_proximity_bonus` | 2.0 | Less co-occurrence reward | Multi-term sections promoted |
| `full_coverage_bonus` | 5.0 | Less full-match reward | All-terms sections promoted |
| `prefix_penalty` | 0.5 | Prefix closer to exact | Prefix heavily discounted |

**By corpus type:**
- API reference: `k1=0.8, b=0.9, code_weight=2.5`
- Tutorials: defaults work well
- Mixed corpus: `k1=1.0, b=0.6, full_coverage_bonus=8.0`

---

## Scaling Path

| Scale | Approach | Storage |
|-------|----------|---------|
| <1K docs | This design: in-memory | ~25-50MB RAM |
| 1K-10K | SQLite FTS5 for inverted index | ~50-200MB disk |
| 10K-50K | Pagefind-style chunked index + vectors | ~500MB disk |
| 50K+ | Full vector DB + tree index | External DB |

---

## Acknowledgments

- **PageIndex** ([pageindex.ai](https://pageindex.ai)) — Tree navigation,
  agent reasoning, the 5-tool interface pattern. The foundational insight
  that LLM judgment outperforms vector similarity for structured retrieval.

- **Pagefind** ([pagefind.app](https://pagefind.app)) by **CloudCannon** —
  BM25 scoring, positional inverted index, weighted locations, density
  excerpts, configurable ranking, section sub-results, stemming, prefix
  matching, filter facets, content hashing, multisite search, custom
  metadata, and content weighting. The search engine that taught us how
  to build a search engine. If you need search for a static site, just
  use Pagefind directly — it's brilliant.

- **Bun.markdown** ([bun.sh](https://bun.sh)) by **Oven** — Native
  CommonMark parser with render callbacks enabling zero-cost tree
  construction from raw markdown.

- **Astro Starlight** ([starlight.astro.build](https://starlight.astro.build))
  — The documentation framework whose Pagefind integration prompted this
  entire investigation. Asking "what search does Starlight use?" led here.

---

## License & Attribution

This is an original implementation. No code was copied from PageIndex,
Pagefind, Bun, or Starlight. The design patterns, scoring algorithms,
and architectural decisions are adapted from publicly documented
features and academic papers. All sources are cited above.
