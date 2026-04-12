# doctree-mcp

Agentic document retrieval over markdown — BM25 search + tree navigation via MCP.

Give an AI agent structured access to your markdown docs: it searches with BM25, reads the outline, reasons about which sections matter, and retrieves only what it needs. No vector DB, no embeddings, no LLM calls at index time.

With the optional **wiki curation** tools, your AI agent can also **write** new documentation — turning doctree-mcp into an [LLM-maintained wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) where the agent handles the bookkeeping while you curate the sources.

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

## Quick Start

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.com/install | bash

# Run directly — no clone needed
DOCS_ROOT=/path/to/your/markdown/docs bunx doctree-mcp
```

### Claude Desktop Configuration

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bunx",
      "args": ["doctree-mcp"],
      "env": {
        "DOCS_ROOT": "/path/to/your/markdown/docs"
      }
    }
  }
}
```

### Claude Code Configuration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bunx",
      "args": ["doctree-mcp"],
      "env": {
        "DOCS_ROOT": "./docs"
      }
    }
  }
}
```

To enable wiki write mode (lets the agent create new docs):

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bunx",
      "args": ["doctree-mcp"],
      "env": {
        "DOCS_ROOT": "./docs",
        "WIKI_WRITE": "1"
      }
    }
  }
}
```

### Cursor Configuration

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bunx",
      "args": ["doctree-mcp"],
      "env": {
        "DOCS_ROOT": "./docs"
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
DOCS_ROOT=./docs bun run serve        # stdio
DOCS_ROOT=./docs bun run serve:http   # HTTP (port 3100)
```

## MCP Tools

### Read tools (always available)

| Tool | Description |
|------|-------------|
| `list_documents` | Browse catalog with tag/keyword filtering, facet counts, and cross-reference hints |
| `search_documents` | BM25 keyword search with facet filters, glossary expansion, and auto-inlined top results |
| `get_tree` | Hierarchical outline for agent reasoning — structure and word counts, no content |
| `get_node_content` | Retrieve full text of specific sections by node ID |
| `navigate_tree` | Get a section and all descendants in one call |

### Wiki curation tools (opt-in: `WIKI_WRITE=1`)

| Tool | Description |
|------|-------------|
| `find_similar` | BM25 duplicate detection — checks new content against existing docs before writing |
| `draft_wiki_entry` | Generates structural scaffold: suggested path, inferred frontmatter, glossary hits, backlinks |
| `write_wiki_entry` | Validated write with path containment, frontmatter schema checks, and duplicate guards |

## New in This Version

- **Better summaries** — First-sentence extraction instead of raw 200-char truncation
- **Cross-references** — Markdown links between docs are extracted and exposed to agents
- **Content facets** — Auto-detected code languages (`code_languages`) and link presence (`has_links`, `has_code`)
- **Auto-glossary** — Acronym definitions like "TLS (Transport Layer Security)" are automatically extracted from content and used for query expansion
- **Rich search results** — Top 3 results auto-inline full subtree content with facet badges and resolved cross-references
- **Wiki curation** — Three new tools for agent-authored documentation with safety guards

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_ROOT` | `./docs` | Path to markdown repository |
| `DOCS_GLOB` | `**/*.md` | File glob pattern |
| `MAX_DEPTH` | `6` | Max heading depth to index |
| `SUMMARY_LENGTH` | `200` | Characters in node summaries |
| `PORT` | `3100` | HTTP server port |
| `GLOSSARY_PATH` | `$DOCS_ROOT/glossary.json` | Path to abbreviation glossary |
| `WIKI_WRITE` | *(unset)* | Set to `1` to enable wiki curation tools |
| `WIKI_ROOT` | `$DOCS_ROOT` | Filesystem root for wiki writes |
| `WIKI_DUPLICATE_THRESHOLD` | `0.35` | Overlap ratio for duplicate warning |

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for multiple collections, ranking tuning, frontmatter best practices, and glossary setup.

## Using as an LLM Wiki

doctree-mcp supports the [LLM wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — a three-layer architecture where:

1. **Raw sources** (immutable) — your original docs, notes, articles
2. **The wiki** (LLM-maintained) — markdown files the agent builds and maintains
3. **The schema** (human-configured) — `CLAUDE.md` or similar files governing structure

See the [LLM Wiki Guide](docs/LLM-WIKI-GUIDE.md) for a complete walkthrough on setting up an LLM-maintained wiki with doctree-mcp.

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
- [LLM Wiki Guide](docs/LLM-WIKI-GUIDE.md) — setting up an agent-maintained knowledge base
- [Competitive Analysis](docs/COMPETITIVE-ANALYSIS.md) — comparison with PageIndex, QMD, GitMCP, Context7

## Standing on Shoulders

- **[PageIndex](https://pageindex.ai)** — Hierarchical tree navigation and the agent reasoning workflow
- **[Pagefind](https://pagefind.app)** by **[CloudCannon](https://cloudcannon.com)** — BM25 scoring, positional index, filter facets, density excerpts, stemming, and more. Full attribution in [DESIGN.md](docs/DESIGN.md).
- **[Bun.markdown](https://bun.sh)** by **[Oven](https://oven.sh)** — Native CommonMark parser enabling zero-cost tree construction from raw markdown
- **[Andrej Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — The LLM-maintained wiki pattern that inspired the curation toolset

## License

MIT
