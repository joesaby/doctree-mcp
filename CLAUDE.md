# CLAUDE.md — doctree-mcp

## Project Overview

doctree-mcp is an MCP (Model Context Protocol) server that provides agentic document retrieval over markdown repositories. It combines BM25 probabilistic search with hierarchical tree navigation — agents get a table of contents they can reason over, plus precise section retrieval. No vector DB, no embeddings, no LLM calls at index or retrieval time.

## Architecture

```
src/
├── indexer.ts          # Markdown → tree nodes + frontmatter + facets + references + glossary extraction
├── store.ts            # In-memory BM25 search engine + filter facets + glossary + ref map
├── types.ts            # All TypeScript interfaces and ranking defaults
├── tools.ts            # MCP tool registrations (shared by stdio + HTTP servers)
├── prompts.ts          # MCP prompt templates: doc-read + doc-write workflows (all clients)
├── search-formatter.ts # Rich search result formatting with inline content + facet badges
├── curator.ts          # Wiki curation: findSimilar, draftWikiEntry, writeWikiEntry
├── server.ts           # MCP stdio server entry point
├── server-http.ts      # MCP HTTP/Streamable HTTP server variant
└── cli-index.ts        # CLI debugging tool for inspecting indexed output
```

### Key Design Decisions

- **Bun-native**: Uses `Bun.markdown.render()` for parsing, `Bun.hash()` for content hashing, `Bun.Glob` for file discovery. Falls back to regex parser if Bun.markdown unavailable (< 1.3.8).
- **PageIndex-inspired tree navigation**: Agents read an outline, reason about it, then retrieve specific branches. This is more token-efficient than RAG's bag-of-chunks.
- **Pagefind-inspired search**: Positional inverted index with BM25 scoring, density-based snippets, filter facets from frontmatter, content hashing for incremental re-indexing, multisite collection weights.
- **Zero LLM calls**: All indexing and retrieval is deterministic search — no embedding models needed.

### Data Flow

1. **Indexing**: `indexer.ts` scans markdown files → parses frontmatter + heading tree → extracts facets (including auto-inferred `type` from directory structure) → computes content hash
2. **Loading**: `store.ts` builds positional inverted index (term → postings with word positions and weights), filter facet index (key → value → doc_id set), and per-node stats for BM25 normalization
3. **Searching**: Tokenize + stem query → expand via glossary → apply facet filters → compute BM25 scores → apply co-occurrence bonuses + collection weights → generate density-based snippets
4. **Navigation**: Agent calls `get_tree` → compact outline → `get_node_content` or `navigate_tree` for precise retrieval

## Development

```bash
bun install              # Install dependencies
bun test                 # Run test suite
bun run serve            # Start stdio MCP server
bun run serve:http       # Start HTTP MCP server (port 3100)
DOCS_ROOT=./path bun run index  # Debug: inspect indexed output
```

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

### Glossary File Format

Place a `glossary.json` in the docs root (or set `GLOSSARY_PATH`):

```json
{
  "CLI": ["command line interface"],
  "K8s": ["kubernetes"],
  "TLS": ["transport layer security"]
}
```

This enables bidirectional query expansion: searching "CLI" also matches "command line interface" and vice versa.

## MCP Tools

### Read tools (always available)
1. **`list_documents`** — Browse catalog with tag/keyword filtering, returns facet counts and cross-reference hints
2. **`search_documents`** — BM25 keyword search with facet filters, glossary expansion, and auto-inlined top results
3. **`get_tree`** — Hierarchical outline (no content) for agent reasoning
4. **`get_node_content`** — Retrieve full text of specific sections by node ID
5. **`navigate_tree`** — Get a section and all descendants in one call

### Wiki curation tools (opt-in: `WIKI_WRITE=1`)
6. **`find_similar`** — BM25 duplicate detection before writing
7. **`draft_wiki_entry`** — Structural scaffold with inferred frontmatter
8. **`write_wiki_entry`** — Validated write with path containment and duplicate guards

## Code Conventions

- TypeScript with strict mode, ESNext target, bundler module resolution
- No classes in indexer (functional), class-based store (`DocumentStore`)
- Bun test runner (`bun test`) with `.test.ts` files in `tests/`
- Comments reference design influences: PageIndex, Pagefind, Bun.markdown
- Reserved frontmatter keys (not used as facets): title, description, layout, permalink, slug, draft, date

## Frontmatter Best Practices for Indexed Docs

For best search quality, markdown files should include:

```yaml
---
title: "Descriptive Title"
description: "One-line summary for search ranking"
tags: [relevant, terms, here]
type: runbook  # or: guide, reference, procedure, architecture, tutorial
category: auth  # any domain-specific grouping
---
```

When frontmatter is missing:
- **title**: Falls back to first H1, then filename. Generic titles ("Introduction", "index") are auto-prefixed with parent directory name.
- **description**: Falls back to first paragraph summary (first 200 chars).
- **type**: Auto-inferred from directory structure (e.g., `runbooks/` → `runbook`, `guides/` → `guide`).
- **tags**: No auto-generation — must be explicit in frontmatter.
