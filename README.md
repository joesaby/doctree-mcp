# doctree-mcp

Give your AI agent a markdown knowledge base it can search, browse, and write to — no vector DB, no embeddings, no LLM calls at index time.

doctree-mcp is an [MCP](https://modelcontextprotocol.io/) server that indexes your markdown files and exposes them as structured tools. Your agent gets BM25 search, a navigable table of contents, and (optionally) the ability to write new docs — turning any folder of `.md` files into a living knowledge base.

## Getting Started

### 1. Create a docs folder

Any folder of markdown files works. Start simple:

```
my-project/
├── docs/
│   ├── setup.md
│   ├── architecture.md
│   └── runbooks/
│       ├── deploy.md
│       └── rollback.md
└── .mcp.json          ← MCP configuration (created in step 2)
```

Your markdown files work best with frontmatter, but it's not required — doctree-mcp infers what it can:

```markdown
---
title: "Deploy Runbook"
tags: [deploy, production, ci-cd]
type: runbook
category: operations
---

# Deploy Runbook

## Prerequisites

You need access to the CI/CD pipeline and production cluster credentials...
```

When frontmatter is missing, doctree-mcp falls back gracefully:
- **title** — uses first `# Heading`, then filename
- **type** — inferred from directory name (`runbooks/` → `runbook`, `guides/` → `guide`)
- **description** — extracted from the first paragraph

### 2. Connect to your AI agent

Install [Bun](https://bun.sh) if you don't have it, then configure your agent:

#### Claude Code

Add `.mcp.json` to your project root:

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

#### Claude Desktop

Add to your [Claude Desktop config](https://modelcontextprotocol.io/quickstart/user):

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bunx",
      "args": ["doctree-mcp"],
      "env": {
        "DOCS_ROOT": "/absolute/path/to/your/docs"
      }
    }
  }
}
```

#### Cursor

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

That's it. When your agent starts, doctree-mcp indexes your markdown files and makes them available through 5 tools (plus 3 more for writing, if enabled).

### 3. Enable writing (optional)

To let your agent create and update docs, add `WIKI_WRITE`:

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

This unlocks 3 additional wiki curation tools with safety guards: path containment, frontmatter validation, and duplicate detection.

---

## How It Works: Retrieve, Curate, Add

doctree-mcp gives your agent three capabilities over your docs.

### Retrieve: Search and navigate existing docs

Your agent searches, browses the outline, and reads exactly the sections it needs:

```
Agent: I need to understand the token refresh flow.

→ search_documents("token refresh")
  #1  auth/middleware.md § Token Refresh Flow       score: 12.4
  #2  auth/oauth.md § Refresh Token Lifecycle       score: 8.7

→ get_tree("docs:auth:middleware")
  [n1] # Auth Middleware (450 words)
    [n4] ## Token Refresh Flow (180 words)
      [n5] ### Automatic Refresh (90 words)
      [n6] ### Manual Refresh API (150 words)
      [n7] ### Error Handling (200 words)

→ navigate_tree("docs:auth:middleware", "n4")
  Returns n4 + n5 + n6 + n7 — the full section with all subsections.
```

This is more precise than vector RAG. Instead of getting a bag of loosely related paragraphs, your agent sees the document structure, reasons about which sections matter, and retrieves only what it needs — typically **2K-8K tokens** vs. 4K-20K from chunked retrieval.

**The 5 retrieval tools:**

| Tool | What it does |
|------|-------------|
| `list_documents` | Browse the catalog. Filter by tag or keyword. See facet counts and cross-references. |
| `search_documents` | BM25 keyword search. Facet filters, glossary expansion, auto-inlined top results. |
| `get_tree` | Table of contents for a document — headings, word counts, summaries. No content. |
| `get_node_content` | Full text of specific sections by node ID. Up to 10 at once. |
| `navigate_tree` | A section and all its descendants in one call. |

### Curate: Check before writing

Before your agent writes new content, it can check what already exists:

```
Agent: I want to document our JWT validation process.

→ find_similar("JWT validation middleware checks the token signature,
               extracts claims, and verifies expiration...")
  Match: auth/middleware.md (overlap: 0.42) — consider updating instead of creating new

→ draft_wiki_entry(topic: "JWT Validation", raw_content: "...")
  Suggested path: jwt-validation.md
  Inferred frontmatter: { type: "reference", category: "auth", tags: ["jwt", "auth"] }
  Glossary hits: JWT → "JSON Web Token"
  Warning: Similar content exists in auth/middleware.md
```

This prevents duplicate docs from accumulating and helps your agent slot new content into the right place.

### Add: Write validated docs

Once your agent has a draft, it writes with guardrails:

```
→ write_wiki_entry(
    path: "auth/jwt-validation.md",
    frontmatter: {
      title: "JWT Validation",
      type: "reference",
      category: "auth",
      tags: ["jwt", "auth", "middleware"]
    },
    content: "# JWT Validation\n\n## How It Works\n\n...",
    dry_run: true          ← validate first, don't write yet
  )
  Status: dry_run_ok
  Warnings: []

→ write_wiki_entry(
    path: "auth/jwt-validation.md",
    frontmatter: { ... },
    content: "...",
    dry_run: false          ← now write for real
  )
  Status: written
  Doc ID: docs:auth:jwt-validation
```

**The 3 write tools** (enabled with `WIKI_WRITE=1`):

| Tool | What it does |
|------|-------------|
| `find_similar` | Duplicate detection — checks proposed content against existing docs. |
| `draft_wiki_entry` | Scaffold generator — suggests path, frontmatter, tags, backlinks. |
| `write_wiki_entry` | Validated write with path containment, schema checks, duplicate guards, dry-run mode. |

**Safety features:**
- Path containment — can't write outside the wiki root
- Frontmatter validation — enforces key naming, value types
- Duplicate detection — warns when similar content already exists
- Dry-run mode — validate everything without touching disk
- Overwrite protection — won't clobber existing files unless you opt in

---

## The LLM Wiki Pattern

doctree-mcp supports using your agent as a wiki maintainer, inspired by [Andrej Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) concept:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Raw Sources     │     │  The Wiki        │     │  The Schema      │
│  (immutable)     │ ──→ │  (LLM-maintained)│ ←── │  (you define)    │
│                  │     │                  │     │                  │
│  meeting notes   │     │  structured docs │     │  CLAUDE.md rules │
│  Slack threads   │     │  runbooks        │     │  frontmatter     │
│  incident logs   │     │  how-to guides   │     │  directory layout │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Workflow:**
1. You dump raw material into a source folder
2. Your agent reads, synthesizes, and writes structured wiki entries
3. `CLAUDE.md` or similar files define the structure and conventions
4. doctree-mcp handles search, deduplication, and validation

See [docs/LLM-WIKI-GUIDE.md](docs/LLM-WIKI-GUIDE.md) for the full walkthrough.

---

## Frontmatter for Better Search

Frontmatter improves search ranking and faceted filtering. Here's what doctree-mcp uses:

```yaml
---
title: "Descriptive Title"
description: "One-line summary — boosts search ranking"
tags: [relevant, terms, here]
type: runbook            # runbook | guide | reference | tutorial | architecture | adr | ...
category: auth           # any domain grouping
---
```

All frontmatter fields (except reserved ones like `title`, `description`, `date`) become **filter facets** you can use in search:

```
search_documents("auth", filters: { "type": "runbook", "tags": ["production"] })
```

doctree-mcp also auto-detects **content facets** from your markdown: code languages, link presence, and code block presence.

## Glossary & Query Expansion

Create a `glossary.json` in your docs root to enable bidirectional query expansion:

```json
{
  "CLI": ["command line interface"],
  "K8s": ["kubernetes"],
  "JWT": ["json web token"]
}
```

Now searching "CLI" also matches "command line interface" and vice versa.

doctree-mcp also **auto-extracts** acronym definitions from your content — patterns like "TLS (Transport Layer Security)" are detected and added to the glossary automatically.

## Multiple Collections

Index docs from multiple directories with per-collection search weights:

```json
{
  "env": {
    "DOCS_ROOTS": "./wiki:1.0,./api-docs:0.8,./meeting-notes:0.3"
  }
}
```

Higher-weighted collections rank higher in search results — useful when your wiki is authoritative but you still want meeting notes searchable.

## Running from Source

```bash
git clone https://github.com/joesaby/doctree-mcp.git
cd doctree-mcp
bun install

DOCS_ROOT=./docs bun run serve          # stdio transport
DOCS_ROOT=./docs bun run serve:http     # HTTP transport (port 3100)
DOCS_ROOT=./docs bun run index          # CLI: inspect indexed output
```

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_ROOT` | `./docs` | Path to your markdown folder |
| `DOCS_GLOB` | `**/*.md` | File glob pattern |
| `DOCS_ROOTS` | — | Multiple weighted collections (alternative to `DOCS_ROOT`) |
| `MAX_DEPTH` | `6` | Max heading depth to index |
| `SUMMARY_LENGTH` | `200` | Characters in node summaries |
| `PORT` | `3100` | HTTP server port |
| `GLOSSARY_PATH` | `$DOCS_ROOT/glossary.json` | Path to abbreviation glossary |
| `WIKI_WRITE` | *(unset)* | Set to `1` to enable write tools |
| `WIKI_ROOT` | `$DOCS_ROOT` | Filesystem root for wiki writes |
| `WIKI_DUPLICATE_THRESHOLD` | `0.35` | Overlap ratio for duplicate warning |

Full details: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## Performance

| Operation | Time | Token cost |
|-----------|------|------------|
| Full index (900 docs) | 2-5s | 0 |
| Incremental re-index | ~50ms | 0 |
| Search | 5-30ms | ~300-1K tokens |
| Tree outline | <1ms | ~200-800 tokens |

Memory: ~25-50MB for 900 docs with full positional index.

## Docs

- [Architecture & Design](docs/DESIGN.md) — BM25 internals, tree navigation, Pagefind/PageIndex attribution
- [Configuration](docs/CONFIGURATION.md) — env vars, frontmatter, ranking tuning, glossary
- [LLM Wiki Guide](docs/LLM-WIKI-GUIDE.md) — setting up an agent-maintained knowledge base
- [Competitive Analysis](docs/COMPETITIVE-ANALYSIS.md) — comparison with PageIndex, QMD, GitMCP, Context7

## Standing on Shoulders

- **[PageIndex](https://pageindex.ai)** — Hierarchical tree navigation and the agent reasoning workflow
- **[Pagefind](https://pagefind.app)** by **[CloudCannon](https://cloudcannon.com)** — BM25 scoring, positional index, filter facets, density excerpts, stemming
- **[Bun.markdown](https://bun.sh)** by **[Oven](https://oven.sh)** — Native CommonMark parser for zero-cost tree construction
- **[Andrej Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — The LLM-maintained wiki pattern that inspired the curation toolset

## License

MIT
