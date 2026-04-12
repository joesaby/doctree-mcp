# doctree-mcp

Give your AI agent a markdown knowledge base it can search, browse, and write to — no vector DB, no embeddings, no LLM calls at index time.

doctree-mcp is an [MCP](https://modelcontextprotocol.io/) server that indexes your markdown files and exposes them as structured tools. Your agent gets BM25 search, a navigable table of contents, and (optionally) the ability to write and maintain docs.

---

## Quick Start

### Already have docs?

1. Point `DOCS_ROOT` at your markdown folder in your AI tool's MCP config (see [Setup by AI Tool](#setup-by-ai-tool) below)
2. Restart your AI tool
3. Ask your agent: *"Search the docs for X"* or use the `doc-read` MCP prompt

### Starting fresh? (LLM Wiki)

Run the init command in your project root:

```bash
bunx doctree-mcp init
```

This scaffolds the [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) three-layer structure and configures your AI tool(s) automatically:

- Creates `docs/wiki/` (LLM-maintained) and `docs/raw-sources/` (your inputs)
- Writes MCP config for your selected AI tool(s)
- Installs a post-write lint hook so your agent gets health warnings automatically
- Appends wiki conventions to `CLAUDE.md` / `AGENTS.md` / `.cursor/rules/`

```bash
bunx doctree-mcp init --all     # configure all supported tools
bunx doctree-mcp init --dry-run # preview without writing
```

See [docs/LLM-WIKI-GUIDE.md](docs/LLM-WIKI-GUIDE.md) for the full walkthrough.

---

## Setup by AI Tool

All tools use the same MCP server. Replace `./docs` with your actual docs path.

### Claude Code

Add `.mcp.json` to your project root:

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

**Workflow prompts:** Use `/doc-read`, `/doc-write`, `/doc-lint` slash commands (skills included in this repo).

**Lint hook** — add to `.claude/settings.json` to get health warnings after every write:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "write_wiki_entry",
        "hooks": [{ "type": "command", "command": "bunx doctree-mcp lint" }]
      }
    ]
  }
}
```

---

### Cursor

Add `.cursor/mcp.json` to your project root:

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

**Workflow prompts:** Use the `doc-read`, `doc-write`, and `doc-lint` MCP prompts from the chat panel.

**Lint hook** — add to `.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "afterMCPExecution": [{ "command": "bunx doctree-mcp lint" }]
  }
}
```

**Rules** — commit `.cursor/rules/doctree-wiki.mdc` with your wiki conventions (created by `bunx doctree-mcp init`).

---

### Windsurf

Add `.windsurf/mcp.json` to your project root:

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

**Workflow prompts:** Use the `doc-read`, `doc-write`, and `doc-lint` MCP prompts from Cascade.

**Lint hook** — add to `.windsurf/hooks.json` (runs after all MCP calls — fast and safe):

```json
{
  "hooks": {
    "post_mcp_tool_use": [{ "command": "bunx doctree-mcp lint" }]
  }
}
```

---

### Codex CLI

Add to `.codex/config.toml`:

```toml
[mcp_servers.doctree]
command = "bunx"
args = ["doctree-mcp"]

[mcp_servers.doctree.env]
DOCS_ROOT = "./docs"
WIKI_WRITE = "1"
```

**Workflow prompts:** Use the `doc-read`, `doc-write`, and `doc-lint` MCP prompts.

**Lint hook:** Codex hooks currently only intercept Bash tool calls. MCP tool interception is not yet supported — run `bunx doctree-mcp lint` manually or use the `doc-lint` prompt for audits.

---

### OpenCode

Add to `opencode.json`:

```json
{
  "mcp": {
    "servers": {
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
}
```

**Workflow prompts:** Use the `doc-read`, `doc-write`, and `doc-lint` MCP prompts.

**Lint plugin** — add `.opencode/plugins/doctree-lint.js` (created by `bunx doctree-mcp init`):

```javascript
export const DoctreeLintPlugin = async ({ $ }) => ({
  "tool.execute.after": async (event) => {
    if (event?.tool?.name === "write_wiki_entry") {
      try { await $`bunx doctree-mcp lint`; } catch {}
    }
  },
});
```

---

### Claude Desktop

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

> Claude Desktop does not support project-level hook configs. Use `bunx doctree-mcp lint` manually or invoke the `doc-lint` MCP prompt for audits.

---

## How It Works: Retrieve · Curate · Add

### Retrieve

```
Agent: I need to understand the token refresh flow.

→ search_documents("token refresh")
  #1  auth/middleware.md § Token Refresh Flow       score: 12.4
  #2  auth/oauth.md § Refresh Token Lifecycle       score: 8.7

→ get_tree("docs:auth:middleware")
  [n1] # Auth Middleware (450 words)
    [n4] ## Token Refresh Flow (180 words)
      [n5] ### Automatic Refresh (90 words)

→ navigate_tree("docs:auth:middleware", "n4")
  Returns n4 + n5 — the full section and all subsections.
```

**5 retrieval tools:**

| Tool | What it does |
|------|-------------|
| `list_documents` | Browse the catalog. Filter by tag or keyword. |
| `search_documents` | BM25 keyword search with facet filters and glossary expansion. |
| `get_tree` | Table of contents — headings, word counts, summaries. |
| `get_node_content` | Full text of specific sections by node ID. |
| `navigate_tree` | A section and all its descendants in one call. |

### Curate

```
→ find_similar("JWT validation middleware checks the token signature...")
  [overlap: 0.42] docs:auth:middleware — Auth Middleware
    ⚠ Consider updating this doc instead of creating a new one.
    → navigate_tree("docs:auth:middleware", "<root_node_id>") to read it

→ navigate_tree("docs:auth:middleware", "n1")   ← read existing doc
→ write_wiki_entry(path: "auth/middleware.md", ..., overwrite: true)  ← merge + update
```

### Add

```
→ draft_wiki_entry(topic: "JWT Validation", raw_content: "...")
  Suggested path:  docs/wiki/auth/jwt-validation.md
  Inferred type:   reference
  Suggested tags:  jwt, auth, middleware

→ write_wiki_entry(..., dry_run: true)   ← validate first
  Status: dry_run_ok

→ write_wiki_entry(..., dry_run: false)  ← write
  Status: written  |  Doc ID: docs:auth:jwt-validation
```

**3 write tools** (enabled with `WIKI_WRITE=1`):

| Tool | What it does |
|------|-------------|
| `find_similar` | Duplicate detection with overlap ratios and update suggestions. |
| `draft_wiki_entry` | Scaffold: suggested path, inferred frontmatter, glossary hits. |
| `write_wiki_entry` | Validated write: path containment, schema checks, duplicate guards, dry-run. |

**Safety:** path containment · frontmatter validation · duplicate detection · dry-run · overwrite protection

---

## The LLM Wiki Pattern

doctree-mcp supports using your agent as a wiki maintainer — inspired by [Andrej Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Raw Sources     │     │  The Wiki        │     │  The Schema      │
│  (immutable)     │ ──→ │  (LLM-maintained)│ ←── │  (you define)    │
│                  │     │                  │     │                  │
│  meeting notes   │     │  structured docs │     │  CLAUDE.md rules │
│  articles        │     │  runbooks        │     │  frontmatter     │
│  incident logs   │     │  how-to guides   │     │  directory layout │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

See [docs/LLM-WIKI-GUIDE.md](docs/LLM-WIKI-GUIDE.md) for the full walkthrough.

---

## Frontmatter for Better Search

```yaml
---
title: "Descriptive Title"
description: "One-line summary — boosts search ranking"
tags: [relevant, terms, here]
type: runbook            # runbook | guide | reference | tutorial | architecture | adr
category: auth           # any domain grouping
---
```

All frontmatter fields (except reserved ones) become **filter facets**:

```
search_documents("auth", filters: { "type": "runbook", "tags": ["production"] })
```

## Glossary & Query Expansion

Place `glossary.json` in your docs root:

```json
{ "CLI": ["command line interface"], "K8s": ["kubernetes"] }
```

doctree-mcp also **auto-extracts** acronym definitions — patterns like "TLS (Transport Layer Security)" are detected and added automatically.

## Multiple Collections

```json
{ "env": { "DOCS_ROOTS": "./wiki:1.0,./api-docs:0.8,./meeting-notes:0.3" } }
```

Higher-weighted collections rank higher in search results.

## Running from Source

```bash
git clone https://github.com/joesaby/doctree-mcp.git
cd doctree-mcp
bun install

DOCS_ROOT=./docs bun run serve          # stdio
DOCS_ROOT=./docs bun run serve:http     # HTTP (port 3100)
DOCS_ROOT=./docs bun run index          # CLI: inspect indexed output
```

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_ROOT` | `./docs` | Path to your markdown folder |
| `DOCS_GLOB` | `**/*.md` | File glob pattern |
| `DOCS_ROOTS` | — | Multiple weighted collections |
| `MAX_DEPTH` | `6` | Max heading depth to index |
| `SUMMARY_LENGTH` | `200` | Characters in node summaries |
| `PORT` | `3100` | HTTP server port |
| `GLOSSARY_PATH` | `$DOCS_ROOT/glossary.json` | Abbreviation glossary |
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

## Docs

- [LLM Wiki Guide](docs/LLM-WIKI-GUIDE.md) — agent-maintained knowledge base walkthrough
- [Architecture & Design](docs/DESIGN.md) — BM25 internals, tree navigation
- [Configuration](docs/CONFIGURATION.md) — env vars, frontmatter, ranking tuning
- [Competitive Analysis](docs/COMPETITIVE-ANALYSIS.md) — comparison with PageIndex, QMD, GitMCP
- [Prompts source](src/prompts.ts) — MCP prompt templates (all clients)
- [Skills: `/doc-read`](.claude/skills/doc-read/SKILL.md), [`/doc-write`](.claude/skills/doc-write/SKILL.md), [`/doc-lint`](.claude/skills/doc-lint/SKILL.md) — Claude Code slash commands

## Standing on Shoulders

- **[PageIndex](https://pageindex.ai)** — Hierarchical tree navigation
- **[Pagefind](https://pagefind.app)** by **[CloudCannon](https://cloudcannon.com)** — BM25 scoring, positional index, filter facets
- **[Bun.markdown](https://bun.sh)** by **[Oven](https://oven.sh)** — Native CommonMark parser
- **[Andrej Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — The LLM-maintained wiki pattern

## License

MIT
