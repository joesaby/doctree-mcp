# Configuration Reference

## Environment Variables

### Markdown indexing

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_ROOT` | `./docs` | Path to markdown repository root |
| `DOCS_GLOB` | `**/*.md` | File glob pattern |
| `MAX_DEPTH` | `6` | Max heading depth to index (1–6) |
| `SUMMARY_LENGTH` | `200` | Characters in node summaries |
| `PORT` | `3100` | HTTP server port (`serve:http` only) |
| `GLOSSARY_PATH` | `$DOCS_ROOT/glossary.json` | Path to abbreviation glossary |

### Code navigation (AST-based)

Set `CODE_ROOT` to enable AST-based code indexing alongside markdown docs.

| Variable | Default | Description |
|----------|---------|-------------|
| `CODE_ROOT` | *(disabled)* | Path to source code root. Set this to enable code indexing. |
| `CODE_COLLECTION` | `code` | Name for the code collection |
| `CODE_WEIGHT` | `1.0` | BM25 weight multiplier for code results vs docs |
| `CODE_GLOB` | all supported extensions | Glob pattern for code files |

**Supported languages:** TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Scala, C, C++, C#, Ruby, Swift, PHP, Lua, Shell

**How it works:** Source files are parsed into the same tree structure used for markdown. Classes, functions, interfaces, and types become tree nodes with parent-child relationships (e.g., class → methods). All existing tools (`search_documents`, `get_tree`, `get_node_content`, `navigate_tree`) work on code files unchanged. The `find_symbol` tool provides code-specific filtering by symbol kind and language.

**Auto-generated facets for code:**

| Facet | Values | Description |
|-------|--------|-------------|
| `language` | `typescript`, `python`, `go`, etc. | Detected from file extension |
| `content_type` | `code` | Distinguishes code from markdown docs |
| `symbol_kind` | `class`, `function`, `interface`, `type`, `enum`, `method`, `variable` | Symbol types found in the file |

**Examples:**

```bash
# Docs only (default)
DOCS_ROOT=./docs bun run serve

# Docs + code
DOCS_ROOT=./docs CODE_ROOT=./src bun run serve

# Code only
DOCS_ROOT=/dev/null CODE_ROOT=./src bun run serve

# Code with custom glob (TypeScript only)
CODE_ROOT=./src CODE_GLOB="**/*.{ts,tsx}" bun run serve

# Weight docs higher than code in unified search results
CODE_ROOT=./src CODE_WEIGHT=0.8 bun run serve
```

---

## Multiple Collections

Index multiple doc folders as weighted collections (Pagefind multisite style):

```bash
# .env
DOCS_ROOTS=./docs:1.0,./api-specs:0.8,./rfcs:0.5
```

Each collection is named from its folder. The weight multiplier is applied to BM25 scores at query time, so a result from `docs` (weight 1.0) will outrank an equally relevant result from `rfcs` (weight 0.5). An automatic `collection` filter facet is added to every document.

---

## Ranking Tuning

BM25 parameters can be set via environment variables. Defaults work well for most documentation corpora.

| Variable | Default | Effect |
|----------|---------|--------|
| `BM25_K1` | `1.2` | TF saturation — lower means repeated terms matter less |
| `BM25_B` | `0.75` | Length normalization — higher promotes shorter sections |
| `TITLE_WEIGHT` | `3.0` | Boost for matches in headings |
| `CODE_WEIGHT` | `1.5` | Boost for matches in code blocks |

**By corpus type:**

- **API reference:** `BM25_K1=0.8, BM25_B=0.9, CODE_WEIGHT=2.5` — short sections, high code density
- **Tutorials:** defaults work well
- **Mixed corpus:** `BM25_K1=1.0, BM25_B=0.6` — varied section lengths

See [DESIGN.md](./DESIGN.md#scoring-tuning-guide) for the full parameter reference.

---

## Glossary (Query Expansion)

Place a `glossary.json` in your docs root to enable bidirectional query expansion. Searching for either the abbreviation or the full form will match both.

```json
{
  "CLI": ["command line interface"],
  "TLS": ["transport layer security"],
  "JWT": ["json web token"],
  "K8s": ["kubernetes"]
}
```

Override the default path:

```bash
GLOSSARY_PATH=/path/to/glossary.json
```

---

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

### Fallbacks when frontmatter is missing

| Field | Fallback | Notes |
|-------|----------|-------|
| `title` | First H1, then filename | Generic titles ("Introduction", "index") are auto-prefixed with the parent directory name |
| `description` | First 200 chars of first section | Explicit descriptions rank 2x better |
| `type` | Auto-inferred from directory structure | See table below |
| `tags` | None | Must be explicit — no auto-generation |

### Reserved frontmatter keys

These are used internally and not exposed as filter facets: `title`, `description`, `layout`, `permalink`, `slug`, `draft`, `date`.

### Auto-inferred `type` from directory structure

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

If a file is in none of the above directories, `type` is only set if declared explicitly in frontmatter.
