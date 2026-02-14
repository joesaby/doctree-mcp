# doctree-mcp — Competitive Landscape Analysis

_Last verified: February 2026_

This document positions doctree-mcp against the MCP document retrieval
ecosystem. For architecture and attribution details, see [DESIGN.md](./DESIGN.md).

---

## The Landscape

Six projects occupy the MCP document retrieval space. Each makes different
trade-offs across search quality, token efficiency, setup friction,
and infrastructure requirements.

| Project | Approach | Stars | Local/Cloud | LLM at Index | LLM at Query |
|---------|----------|-------|-------------|--------------|--------------|
| **doctree-mcp** | BM25 + tree navigation | Early stage | Local | No | No |
| **PageIndex** (VectifyAI) | LLM tree search | 15K (lib) / 209 (MCP) | Both | Yes | Yes |
| **QMD** (Tobi Lütke) | BM25 + vectors + LLM reranker | — | Local | Yes (embeddings) | Yes (reranker) |
| **GitMCP** (idosal) | GitHub proxy | 7.6K | Cloud | No | No |
| **docs-mcp-server** (arabold) | General indexer + optional embeddings | — | Local | Optional | Optional |
| **MCP-Markdown-RAG** (Zackriya) | Vector RAG over markdown (Milvus) | — | Local | Yes (embeddings) | No |
| **Context7** (Upstash) | Pre-indexed OSS library docs | 45.7K | Cloud | — | — |

---

## Head-to-Head Comparisons

### 1. PageIndex — Closest Philosophical Cousin

**Repo:** [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex) (15,094 stars),
[VectifyAI/pageindex-mcp](https://github.com/VectifyAI/pageindex-mcp) (209 stars)

PageIndex pioneered the tree navigation concept that doctree-mcp adopts.
Its Mafin 2.5 system achieved 98.7% accuracy on FinanceBench
([VentureBeat](https://venturebeat.com/infrastructure/this-tree-search-framework-hits-98-7-on-documents-where-vector-search-fails/)),
a benchmark involving multi-hop queries over financial documents with
internal cross-references.

**How the architectures diverge:**

PageIndex uses LLM calls at both index time (GPT-4o builds tree structures
from PDFs, generates node summaries) and retrieval time (the LLM navigates
the tree to find relevant sections). doctree-mcp uses zero LLM calls at
either stage — markdown headings provide the tree for free, and BM25
handles ranking.

PageIndex offers three deployment modes: cloud API, cloud OAuth, and local
via `npx`. It is not cloud-only, but its recommended path involves API keys
and hosted infrastructure.

**Where PageIndex wins:**

- Complex multi-hop queries on professional documents with heavy
  cross-referencing (financial reports, legal contracts). The LLM reasons
  *within* the retrieval pipeline, following breadcrumbs across sections.
- PDF documents where structure must be inferred rather than parsed.

**Where doctree-mcp wins:**

- Speed: 5-30ms queries with zero LLM tokens vs hundreds of milliseconds
  minimum (LLM inference floor). For an agent making 10-15 retrieval calls,
  this compounds.
- Cost: Zero API spend at any volume. PageIndex's LLM calls at both index
  and retrieval make large-scale use expensive.
- Simplicity: `bun run serve` with a path to markdown. No API keys, no
  model configuration, no cloud dependency.

**Honest assessment:** For well-structured markdown docs, the two deliver
comparable retrieval quality. For complex PDFs with cross-references,
PageIndex will outperform because it can reason across section boundaries
during retrieval — something BM25 fundamentally cannot do.

---

### 2. QMD — Best Single-Query Precision

**Repo:** [tobi/qmd](https://github.com/tobi/qmd) — by Tobias Lütke (Shopify CEO)

QMD runs a three-stage hybrid pipeline locally: BM25 via SQLite FTS5,
vector semantic search via embeddings, and LLM re-ranking via a fine-tuned
Qwen reranker. All models run locally via node-llama-cpp with GGUF files
(~2GB total: 300MB embeddings, 640MB reranker, 1.1GB query expansion).
Supports both stdio and HTTP MCP transports.

**Where QMD wins:**

- Semantic matching. A search for "how to handle expired credentials" will
  find docs about "token refresh flow" because vector similarity bridges
  the vocabulary gap. doctree-mcp's BM25 with stemming and prefix matching
  will partially bridge this, but cannot make the semantic leap.
- Single-query precision. The BM25 + vector + reranker pipeline gives QMD
  the best accuracy on any individual question.

**Where doctree-mcp wins:**

- No model downloads. QMD requires ~2GB of GGUF models on first run.
  doctree-mcp has two npm dependencies.
- No GPU/CPU inference overhead. QMD loads models into memory (hundreds of
  MB to GB). doctree-mcp uses ~25-50MB for 900 docs.
- Structure awareness. QMD returns ranked chunks — the agent gets answers
  but cannot browse document structure, reason about section hierarchy, or
  selectively retrieve branches. For multi-step reasoning over a document's
  architecture, tree navigation outperforms flat chunk retrieval.
- Speed. QMD's hybrid pipeline involves model inference at query time.
  doctree-mcp returns in 5-30ms.

**Honest assessment:** QMD has better search recall for fuzzy/semantic
queries. doctree-mcp has better agent workflow support via tree navigation.
They optimize for different things — if your docs use consistent
terminology, BM25 is sufficient and the tree navigation advantage matters
more. If your queries frequently use different vocabulary than your docs,
QMD's semantic search is genuinely valuable.

---

### 3. GitMCP — Zero-Friction OSS Access

**Repo:** [idosal/git-mcp](https://github.com/idosal/git-mcp) (7,600 stars)

GitMCP is a cloud-hosted MCP server on Cloudflare Workers at `gitmcp.io`.
Paste a URL into your MCP config and it works immediately — no cloning,
no indexing, no installation. It fetches docs from any public GitHub repo
on the fly, prioritizing `llms.txt` (falling back to README and GitHub
Pages content). Has four tools including `search_code` via GitHub's
code search API.

**Where GitMCP wins:**

- Zero setup. Unbeatable time-to-value for quick questions about any
  OSS project.
- Breadth. Works on any public GitHub repo instantly. The generic endpoint
  (`gitmcp.io/docs`) lets the agent pick the repo dynamically.
- Code search. Leverages GitHub's code search API — doctree-mcp is
  documentation-only.

**Where doctree-mcp wins:**

- Retrieval quality. GitMCP has no inverted index, no relevance scoring,
  no ranking. If a project lacks `llms.txt` (most don't), the agent gets
  a README blob. doctree-mcp builds a proper BM25-scored index with
  positional data and density-based snippets.
- Structure. GitMCP has no concept of heading hierarchy or section-level
  retrieval. It delivers flat content — "here's the doc." doctree-mcp lets
  the agent see `[n4] ## Token Refresh Flow (180 words)` and decide
  whether to pull it.
- Token efficiency. GitMCP often dumps full pages into context (10-20K+
  tokens of unfiltered content). doctree-mcp lets the agent budget tokens
  by picking exact sections (2-8K tokens of precise content).
- **Private and enterprise docs.** GitMCP explicitly states it "only
  accesses content that is already publicly available." No authentication,
  no support for GitHub Enterprise Server behind VPN/firewall. doctree-mcp
  works entirely offline on any markdown on disk.
- Latency. 5-30ms local vs network round-trips to GitHub's API, subject
  to rate limits.

**Honest assessment:** These aren't really competing for the same user.
GitMCP solves discovery (quickly get context on any OSS project).
doctree-mcp solves precision retrieval (navigate and extract exactly what
you need from a known corpus). An engineer might use GitMCP to explore a
new library, then switch to doctree-mcp once that library's docs become
part of their daily workflow.

---

### 4. docs-mcp-server — General-Purpose Doc Indexer

**Repo:** [arabold/docs-mcp-server](https://github.com/arabold/docs-mcp-server)

Self-described "open-source alternative to Context7, Nia, and Ref.Tools."
Indexes websites, GitHub repos, local folders. Supports HTML, Markdown,
PDF, Word, Excel, PowerPoint, and source code. Optionally uses embeddings
(OpenAI, Ollama, Gemini, Azure, Bedrock) for semantic search.

**Where docs-mcp-server wins:**

- Format breadth. Handles PDF, Word, Excel, PowerPoint — doctree-mcp is
  markdown-only.
- Optional semantic search via configurable embedding providers.
- Can index remote URLs and GitHub repos directly.

**Where doctree-mcp wins:**

- Tree navigation. docs-mcp-server is traditional RAG via MCP — chunks
  and retrieval, no heading hierarchy or structural reasoning.
- Zero external dependencies. docs-mcp-server's semantic search requires
  an embedding provider (API keys, model configuration). Without
  embeddings, its search quality drops significantly.
- Purpose-built vs general-purpose. doctree-mcp's five-tool workflow is
  designed specifically for how agents reason over documentation structure.

---

### 5. MCP-Markdown-RAG — Classic Vector RAG Baseline

**Repo:** [Zackriya-Solutions/MCP-Markdown-RAG](https://github.com/Zackriya-Solutions/MCP-Markdown-RAG)

Standard vector-based semantic search over markdown files using a
file-based Milvus vector database. Chunks documents, computes embeddings
(~50MB model downloaded on first run), stores in Milvus, retrieves by
cosine similarity.

This represents the "standard RAG" approach that doctree-mcp explicitly
contrasts against. The trade-off is straightforward: MCP-Markdown-RAG
gets semantic matching (vocabulary-independent similarity) at the cost
of chunking artifacts (losing document structure), embedding overhead,
and a vector database dependency. doctree-mcp gets structural awareness
and zero-dependency speed at the cost of keyword-only matching.

---

### 6. Context7 — Pre-Indexed OSS Library Docs

**Repo:** [upstash/context7](https://github.com/upstash/context7) (45,700 stars, #3 MCP server globally)

Cloud-hosted, community-contributed registry of pre-indexed open-source
library documentation (Next.js, MongoDB, Supabase, etc.). Completely
different use case — Context7 solves "give me the latest framework docs"
while doctree-mcp solves "let an agent navigate my documentation."

Context7 cannot index private or internal documentation. Its backend
(API, parsing, crawling) is proprietary and not open source. It is
complementary rather than competitive.

---

## Cross-Cutting Analysis

### Agentic Query Performance

How each system performs across different query patterns:

| Query Type | Best | Runner-up | Notes |
|-----------|------|-----------|-------|
| Well-structured markdown docs | doctree-mcp ≈ PageIndex | QMD | Tree navigation compensates for BM25-only search |
| Complex PDFs with cross-references | PageIndex | doctree-mcp | LLM reasoning follows breadcrumbs across sections |
| Fuzzy/semantic queries | QMD | PageIndex | Vector search bridges vocabulary gaps |
| Agent autonomy (browsing + deciding) | doctree-mcp ≈ PageIndex | — | QMD/GitMCP lack tree navigation entirely |
| Multi-step workflow (10+ tool calls) | doctree-mcp | PageIndex | 5-30ms vs LLM inference latency per call |

### The BM25 Limitation — An Honest Acknowledgment

BM25-only search is doctree-mcp's main vulnerability. If someone searches
"how to handle expired credentials" but the docs say "token refresh flow,"
BM25 with stemming and prefix matching will partially bridge the gap but
cannot make the semantic connection that QMD's vector search would.

This matters less than it might seem for the target use case (structured
markdown docs that the user controls), because:

1. Documentation authors tend to use consistent terminology
2. The agent can browse the tree to discover sections by title
3. Prefix matching catches many partial-term overlaps
4. The five-tool workflow lets the agent iterate (search → browse → refine)

But for corpora with inconsistent terminology or natural-language queries
from users unfamiliar with the docs' vocabulary, this is a real gap.

### Large Volume Scaling

| System | 900 docs | 5,000 docs (est.) | 10,000+ docs (est.) |
|--------|----------|-------------------|----------------------|
| **doctree-mcp** | 2-5s, 0 LLM tokens | ~15-25s (linear) | ~30-50s |
| **PageIndex** | Minutes (LLM calls per doc) | Expensive | Impractical without caching |
| **QMD** | Minutes (model loading + embedding) | 10-30 min | Scales with model inference |
| **docs-mcp-server** | Varies (depends on embedding provider) | Varies | Varies |

doctree-mcp's zero-LLM, zero-embedding indexing is the most scalable of
the group. The known boundary: the positional inverted index lives entirely
in memory. At 10,000+ documents with hundreds of thousands of sections,
this could grow to several hundred MB. The scaling path
(see [DESIGN.md](./DESIGN.md#scaling-path)) acknowledges this and maps
tiers from in-memory to SQLite FTS5 to chunked indexes.

### Token Efficiency

For the same retrieval task, total tokens consumed (index + retrieval):

| System | Index tokens | Per-query tokens | Agent workflow (10 calls) |
|--------|-------------|------------------|--------------------------|
| **doctree-mcp** | 0 | ~300-1K | ~3K-10K |
| **PageIndex** | Thousands per doc | Hundreds-thousands (LLM reasoning) | ~10K-50K+ |
| **QMD** | 0 (local models) | 0 (local models) | 0 (local models) |
| **GitMCP** | 0 | ~10K-20K (full pages dumped) | ~100K-200K |

QMD technically wins here since it uses local models with zero API tokens,
but at the cost of ~2GB of local model files and GPU/CPU inference.
doctree-mcp is the most token-efficient system that doesn't require
downloading ML models.

### The Enterprise Blind Spot

Most popular MCP doc servers assume public access:

| System | Private repos | Enterprise GitHub | Offline | No data leaves perimeter |
|--------|--------------|-------------------|---------|------------------------|
| **doctree-mcp** | Yes | Yes | Yes | Yes |
| **PageIndex** | Via local mode | Via local mode | Via local mode | Via local mode |
| **QMD** | Yes | Yes | Yes | Yes |
| **GitMCP** | No | No | No | No |
| **docs-mcp-server** | Local mode only | Local mode only | Local mode only | Depends on config |
| **Context7** | No | No | No | No |

For regulated industries (telecom, finance, healthcare) where documentation
cannot leave the network perimeter, the options narrow to systems that run
entirely locally with no external calls. doctree-mcp and QMD both qualify.
doctree-mcp additionally makes no network calls of any kind — not even to
download models.

---

## Positioning

doctree-mcp occupies a specific niche: **structured local-first document
retrieval for agents, with zero external dependencies.**

It trades:
- GitMCP's convenience for retrieval precision and offline capability
- PageIndex's LLM reasoning for zero-cost speed and simplicity
- QMD's semantic matching for zero-model-download operation
- Vector RAG's vocabulary independence for structural awareness

The 90% case — structured markdown documentation that agents need to
navigate efficiently — gets comparable retrieval quality at a fraction
of the cost, latency, and complexity.

The 10% where alternatives win: complex PDFs with cross-references
(PageIndex), semantic fuzzy matching across inconsistent terminology (QMD),
zero-setup access to any OSS project (GitMCP).

---

## Where to List doctree-mcp

Registries for MCP server visibility:

1. **GitHub MCP Registry** — [github.com/mcp](https://github.com/mcp) — Official GitHub-hosted registry
2. **mcpservers.org** — Submit at mcpservers.org/submit (wong2/awesome-mcp-servers web directory)
3. **punkpeye/awesome-mcp-servers** — [github.com/punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
4. **appcypher/awesome-mcp-servers** — [github.com/appcypher/awesome-mcp-servers](https://github.com/appcypher/awesome-mcp-servers) — "Knowledge & Memory" category
5. **PulseMCP** — [pulsemcp.com](https://pulsemcp.com)
6. **Glama.ai** — [glama.ai/mcp/servers](https://glama.ai/mcp/servers)

---

## Methodology

All claims in this document were independently verified against source
repositories, README files, and published articles as of February 2026.
Star counts, feature claims, and architectural details were cross-checked
against actual code and documentation. Corrections from initial research:

- PageIndex main repo has 15,094 stars (not ~136 as initially reported;
  the MCP wrapper repo has 209)
- PageIndex offers local deployment via `npx`, not cloud-only
- GitMCP prioritizes `llms.txt` but falls back gracefully to README
  (not solely dependent on `llms.txt`)
- Context7 is community-contributed, not strictly curated
