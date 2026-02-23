# doctree-mcp

Agentic document retrieval over markdown and source code — BM25 search + tree navigation via MCP.

Give an AI agent structured access to your markdown docs and codebase: it searches with BM25, reads the outline, reasons about which sections matter, and retrieves only what it needs. Supports AST-based code navigation for TypeScript, Python, Go, Rust, Java, and more. No vector DB, no embeddings, no LLM calls at index time.

## Why

Standard RAG gives agents a bag of loosely relevant paragraphs. This gives them a **table of contents they can reason over**, plus a search engine that actually ranks by relevance.

```
search_documents("auth token refresh")     → find candidate docs (BM25 ranked)
get_tree("docs:auth:middleware")           → see the heading hierarchy
  [n4] ## Token Refresh Flow (180 words)
    [n5] ### Automatic Refresh (90 words)
    [n6] ### Manual Refresh API (150 words)
    [n7] ### Error Handling (200 words)
navigate_tree("docs:auth:middleware", "docs:auth:middleware:n4") → get exactly n4+n5+n6+n7
```

Context budget: **2K-8K tokens** with precise content, vs 4K-20K tokens of noisy chunks from vector RAG.

The same tree navigation works on source code — classes, functions, and interfaces become tree nodes:

```
find_symbol("authenticate", kind: "function") → find code symbols
get_tree("code:src:auth:service")             → see the file structure
  [n1] class AuthService
    [n2]   method constructor (12 words)
    [n3]   method authenticate (28 words)
    [n4]   method refreshToken (35 words)
  [n5] function validateToken
get_node_content("code:src:auth:service", ["n3"]) → get the function body
```

## Quick Start

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.com/install | bash

# Run directly — no clone needed
DOCS_ROOT=/path/to/your/markdown/docs bunx doctree-mcp
```

### With code navigation

```bash
# Index both docs and source code
DOCS_ROOT=./docs CODE_ROOT=./src bunx doctree-mcp
```

### Claude Desktop Configuration

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bunx",
      "args": ["doctree-mcp"],
      "env": {
        "DOCS_ROOT": "/path/to/your/markdown/docs",
        "CODE_ROOT": "/path/to/your/source/code"
      }
    }
  }
}
```

### Run from source

```bash
git clone https://github.com/joesaby/doctree-mcp.git
cd doctree-mcp
bun install
DOCS_ROOT=./docs bun run serve                     # docs only, stdio
DOCS_ROOT=./docs CODE_ROOT=./src bun run serve      # docs + code
DOCS_ROOT=./docs bun run serve:http                 # HTTP (port 3100)
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_documents` | Browse catalog with tag/keyword filtering and facet counts |
| `search_documents` | BM25 keyword search with facet filters and glossary expansion |
| `get_tree` | Hierarchical outline for agent reasoning — structure and word counts, no content |
| `get_node_content` | Retrieve full text of specific sections by node ID |
| `navigate_tree` | Get a section and all descendants in one call |
| `find_symbol` | Search code symbols by name, kind, and language (requires `CODE_ROOT`) |

## Configuration

```bash
# .env
DOCS_ROOT=./docs    # path to your markdown repository
DOCS_GLOB=**/*.md   # file glob pattern
CODE_ROOT=./src     # path to source code (optional, enables code navigation)
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for multiple collections, ranking tuning, frontmatter best practices, and glossary setup.

## Performance

| Operation | Latency | Token cost |
|-----------|---------|------------|
| Full index (900 docs) | 2-5s | 0 LLM tokens |
| Incremental re-index (5 changed) | ~50ms | 0 LLM tokens |
| Search | 5-30ms | ~300-1K tokens |
| Search with facet filters | 2-15ms | ~200-800 tokens |
| Tree outline | <1ms | ~200-800 tokens |

Memory: ~25-50MB for 900 docs with full positional index and facets.

## Docs

- [Architecture & Design](docs/DESIGN.md) — BM25, tree navigation, Pagefind/PageIndex attribution
- [Configuration Reference](docs/CONFIGURATION.md) — env vars, frontmatter, ranking tuning, glossary
- [Competitive Analysis](docs/COMPETITIVE-ANALYSIS.md) — comparison with PageIndex, QMD, GitMCP, Context7

## Standing on Shoulders

- **[PageIndex](https://pageindex.ai)** — Hierarchical tree navigation and the agent reasoning workflow
- **[Pagefind](https://pagefind.app)** by **[CloudCannon](https://cloudcannon.com)** — BM25 scoring, positional index, filter facets, density excerpts, stemming, and more. Full attribution in [DESIGN.md](docs/DESIGN.md).
- **[Bun.markdown](https://bun.sh)** by **[Oven](https://oven.sh)** — Native CommonMark parser enabling zero-cost tree construction from raw markdown

## License

MIT
