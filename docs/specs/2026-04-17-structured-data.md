# Spec: Structured Data Support (CSV + JSONL)

## Problem

doctree-mcp only indexes markdown files. Structured datasets (CSV exports, JSONL cross-reference indexes) with high-value searchable content are excluded entirely.

## Goal

Index CSV and JSONL files alongside markdown, reusing the existing BM25 engine and tree navigation. Add one new tool (`lookup_row`) for exact key-based row retrieval.

## Design Principles

- **Minimum new API surface.** One new tool, not three.
- **Reuse existing pipeline.** CSV/JSONL → `IndexedDocument` → `TreeNode[]`, same as markdown.
- **Backward compatible.** Default `DOCS_GLOB=**/*.md` — nothing changes for existing deployments.

## How It Works

### File Discovery

`DOCS_GLOB` accepts comma-separated patterns: `**/*.md,**/*.csv,**/*.jsonl`

### CSV Indexing

- One `IndexedDocument` per file, one `TreeNode` per row, synthetic root node
- Column roles auto-detected from header names (id, title, text, facets, url)
- Facets extracted per row into the existing filter index
- Long text fields truncated at `CSV_MAX_TEXT_LENGTH` (default 2000) for BM25; full content stored for retrieval

### JSONL Indexing

- One `IndexedDocument` per file, one `TreeNode` per line
- Schema auto-detected from first line's keys
- Fields named `key`/`id` → node title; `status`/`team`/`corpus` → facets; `paths`/`pages` → relation content

### `lookup_row` Tool

Exact key-based retrieval backed by `rowIndex: Map<string, { doc_id, node_id }>` built at index time. O(1), deterministic, zero ambiguity — unlike `search_documents` which returns ranked results.

```typescript
server.tool("lookup_row", { key: z.string(), doc_id: z.string().optional() });
```

### Deferred: `query_rows`

Faceted browse ("all In Progress for team X") is handled well enough by BM25 since row content includes status text. If needed later, remove the empty-query bail-out in `search_documents` when filters are present.

## File Changes

| File | Change |
|------|--------|
| `src/types.ts` | Add `glob_patterns?: string[]` to `CollectionConfig` |
| `src/indexer.ts` | Add `indexCsvFile()`, `indexJsonlFile()`, multi-glob dispatch |
| `src/store.ts` | Add `rowIndex`, `lookupRow()` |
| `src/tools.ts` | Register `lookup_row` tool |
| `src/server.ts`, `src/server-http.ts` | Wire up new tool |

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `DOCS_GLOB` | `**/*.md` | Comma-separated glob patterns |
| `CSV_MAX_TEXT_LENGTH` | `2000` | Truncate long text fields for BM25 indexing |

## What Does NOT Change

- Markdown indexing, existing tool signatures, tree navigation, BM25 ranking, existing deployments
