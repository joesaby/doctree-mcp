# doctree-mcp

Agentic document retrieval over markdown — BM25 search + tree navigation via MCP.

Give an AI agent structured access to your markdown docs: it searches with BM25, reads the outline, reasons about which sections matter, and retrieves only what it needs. No vector DB, no embeddings, no LLM calls at index time.

## Why

Standard RAG (chunk → embed → retrieve top-k) gives agents a bag of loosely relevant paragraphs. This gives them a **table of contents they can reason over**, plus a search engine that actually ranks by relevance.

The agent workflow:

```
search_documents("auth token refresh")     → find candidate docs (BM25 ranked)
get_tree("docs:auth:middleware")           → see the heading hierarchy
  [n4] ## Token Refresh Flow (180 words)
    [n5] ### Automatic Refresh (90 words)
    [n6] ### Manual Refresh API (150 words)
    [n7] ### Error Handling (200 words)
navigate_tree("docs:auth:middleware", "n4") → get exactly n4+n5+n6+n7
```

Context budget: **2K-8K tokens** with precise content, vs 4K-20K tokens of noisy chunks from vector RAG.

## Features

| Feature | Inspired by | Description |
|---------|-------------|-------------|
| **BM25 scoring** | [Pagefind](https://pagefind.app) | Proper probabilistic ranking with configurable k1, b parameters |
| **Positional index** | [Pagefind](https://pagefind.app) | Word positions per section enable density-based snippet extraction |
| **Tree navigation** | [PageIndex](https://pageindex.ai) | Agent reads outline → reasons → retrieves specific branches |
| **Filter facets** | [Pagefind](https://pagefind.app) | Frontmatter becomes faceted filters (tags, category, status, etc.) |
| **Content hashing** | [Pagefind](https://pagefind.app) | Incremental re-indexing — skip unchanged files |
| **Multi-root** | [Pagefind](https://pagefind.app) | Index multiple doc folders as weighted collections |
| **Stemming** | [Pagefind](https://pagefind.app) | "configuring" matches "configuration" |
| **Prefix matching** | [Pagefind](https://pagefind.app) | "auth" matches "authentication", "authorize" |
| **Native parsing** | [Bun.markdown](https://bun.sh) | Zig-based CommonMark parser, zero LLM calls |

## Quick Start

```bash
# Clone
git clone https://github.com/joesaby/doctree-mcp.git
cd doctree-mcp

# Install
bun install

# Point at your docs
cp .env.example .env
# Edit .env: set DOCS_ROOT to your markdown folder

# Start MCP server (stdio — for Claude Desktop)
bun run serve

# Or start HTTP server (for other MCP clients)
bun run serve:http
```

### Claude Desktop Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bun",
      "args": ["run", "serve"],
      "cwd": "/path/to/doctree-mcp",
      "env": {
        "DOCS_ROOT": "/path/to/your/markdown/docs"
      }
    }
  }
}
```

## MCP Tools

### 1. `list_documents` — Catalog with facets

Browse what's indexed. Returns metadata + facet counts for filtering.

```
list_documents({ tag: "auth", collection: "api" })
→ { total: 23, facet_counts: { category: { guide: 12, reference: 11 } }, documents: [...] }
```

### 2. `search_documents` — BM25 search with filters

Cross-document keyword search. Positional index, density snippets, facet filtering.

```
search_documents("authentication token", { filters: { category: "guide" } })
→ [{ doc_id, node_title: "Token Refresh", score: 14.7, snippet: "…refreshes expired tokens…" }]
```

### 3. `get_tree` — Document outline

Compact heading hierarchy for agent reasoning. No content, just structure + word counts.

```
get_tree("docs:auth:middleware")
→ { nodes: [{ node_id: "n1", title: "Auth Middleware Guide", level: 1, word_count: 45 }, ...] }
```

### 4. `get_node_content` — Section retrieval

Get the actual text for specific sections the agent chose.

```
get_node_content("docs:auth:middleware", ["n4", "n5"])
→ { nodes: [{ title: "Token Refresh Flow", content: "The middleware automatically..." }] }
```

### 5. `navigate_tree` — Branch retrieval

Get a section and all its children in one call.

```
navigate_tree("docs:auth:middleware", "n4")
→ { nodes: [n4, n5, n6, n7] }  // parent + all descendants
```

## Configuration

### Single docs root (common case)

```bash
# .env
DOCS_ROOT=./docs
DOCS_GLOB=**/*.md
```

### Multiple collections (Pagefind multisite style)

```bash
# .env
DOCS_ROOTS=./docs:1.0,./api-specs:0.8,./rfcs:0.5
```

Each collection is named from its folder, with a weight multiplier applied to search scores.

### Ranking tuning

```bash
# .env (optional — defaults work well for most doc sites)
BM25_K1=1.2          # TF saturation (lower = repeated terms matter less)
BM25_B=0.75          # Length normalization (higher = short sections promoted)
TITLE_WEIGHT=3.0     # Heading match boost
CODE_WEIGHT=1.5      # Code block match boost
```

See [DESIGN.md](docs/DESIGN.md) for the full scoring tuning guide with per-corpus-type recommendations.

### Glossary (query expansion for abbreviations)

Place a `glossary.json` in your docs root to enable bidirectional query expansion. This maps abbreviations to their full forms so agents can search using either:

```json
{
  "IG": ["Ingress gateway"],
  "JWT": ["json web token"],
  "K8s": ["kubernetes"]
}
```

Searching for "SSE" will also match "server-sent events" and vice versa. Override the path with `GLOSSARY_PATH=/path/to/glossary.json`.

## Frontmatter Best Practices

For best search quality, add structured metadata to your markdown files:

```yaml
---
title: "Descriptive Title (not 'Introduction')"
description: "One-line summary — gets a 2x weight boost in search ranking"
tags: [relevant, terms, here]
type: runbook        # or: guide, reference, procedure, tutorial, architecture
category: auth       # any domain-specific grouping
---
```

### What happens when frontmatter is missing

| Field | Fallback | Notes |
|-------|----------|-------|
| `title` | First H1, then filename | Generic titles ("Introduction", "index") are auto-prefixed with parent directory name |
| `description` | First 200 chars of first section | Explicit descriptions rank 2x better |
| `type` | Auto-inferred from directory structure | `runbooks/` → runbook, `guides/` → guide, `deploy/` → deployment, etc. |
| `tags` | None | Must be explicit — no auto-generation |

### Supported auto-inferred types

Directory patterns that auto-generate a `type` facet:

| Directory pattern | Inferred type |
|------------------|---------------|
| `runbooks/`, `runbook/` | `runbook` |
| `guides/`, `guide/` | `guide` |
| `tutorials/` | `tutorial` |
| `reference/` | `reference` |
| `api-docs/`, `apidocs/` | `api-reference` |
| `architecture/` | `architecture` |
| `adrs/`, `adr/` | `adr` |
| `rfcs/` | `rfc` |
| `procedures/` | `procedure` |
| `playbooks/` | `playbook` |
| `troubleshoot*/` | `troubleshooting` |
| `ops/` | `operations` |
| `deploy/` | `deployment` |
| `pipeline/` | `pipeline` |
| `onboard*/` | `onboarding` |
| `postmortem/` | `postmortem` |

## How It Works

### Indexing (startup, 2-5s for 900 docs)

1. Scan `.md` files from each collection root
2. Parse with `Bun.markdown.render()` callbacks → section tree
3. Extract frontmatter → metadata + filter facets
4. Auto-infer `type` facet from directory structure (if not in frontmatter)
5. Improve generic titles ("Introduction" → "Auth System — Introduction")
6. Compute content hash for incremental re-indexing
7. Tokenize, stem, build positional inverted index (title 3x, description 2x, code 1.5x)
8. Build facet index from frontmatter values
9. Load glossary for query expansion (if `glossary.json` present)

### Search (5-30ms per query)

1. Tokenize + stem query terms
2. Expand query via glossary (abbreviation ↔ full forms)
3. Apply facet filters (narrow candidate set before scoring)
4. Look up postings in inverted index (exact + prefix)
5. Compute BM25 score per node: `IDF × saturated TF × weight`
6. Apply co-occurrence bonuses + collection weights
7. Generate density-based snippets (highest match concentration)

### Tree Navigation (< 1ms)

1. Agent calls `get_tree` → compact outline
2. Agent reasons: "sections n4-n7 contain my answer"
3. Agent calls `navigate_tree` → full content of the branch
4. Agent synthesizes from precise, structured context

## Performance

| Operation | Latency | Token cost |
|-----------|---------|------------|
| Full index (900 docs) | 2-5s | 0 LLM tokens |
| Incremental re-index (5 changed) | ~50ms | 0 LLM tokens |
| Search | 5-30ms | ~300-1K tokens |
| Search with facet filters | 2-15ms | ~200-800 tokens |
| Tree outline | <1ms | ~200-800 tokens |
| Node content | <1ms | varies |

Memory: ~25-50MB for 900 docs with full positional index + facets.

## Standing on Shoulders

This project is a synthesis of ideas from three excellent projects. Full attribution in [DESIGN.md](docs/DESIGN.md).

- **[PageIndex](https://pageindex.ai)** — The hierarchical tree navigation model and the insight that LLM judgment outperforms vector similarity for structured retrieval.

- **[Pagefind](https://pagefind.app)** by **[CloudCannon](https://cloudcannon.com)** — BM25 scoring, positional inverted index, density excerpts, configurable ranking, filter facets, content hashing, multisite search, stemming, and prefix matching. The search engine that taught us how to build a search engine.

- **[Bun.markdown](https://bun.sh)** by **[Oven](https://oven.sh)** — Native CommonMark parser enabling zero-cost tree construction from raw markdown.

- **[Astro Starlight](https://starlight.astro.build)** — The documentation framework whose Pagefind integration prompted this investigation.

## License

MIT
