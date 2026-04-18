# doctree-mcp

**Agentic document retrieval over markdown, CSV, and JSONL.** BM25 + tree navigation via [MCP](https://modelcontextprotocol.io/) — no vector DB, no embeddings, no LLM calls at index time.

**The pitch:** MCP provides the structural primitives (a navigable tree, BM25, glossary, row lookup). The bundled skills provide the procedural knowledge (how to walk that tree). Together the agent behaves like a trained research librarian — not a one-shot searcher. See [The Skill + MCP Pattern](#the-skill--mcp-pattern).

---

## Quick Start

**Have docs already?** Point a client at them:

```bash
# In your AI tool's MCP config — see docs/CLIENTS.md for per-tool snippets
{ "mcpServers": { "doctree": {
    "command": "bunx", "args": ["doctree-mcp"],
    "env": { "DOCS_ROOT": "./docs", "WIKI_WRITE": "1" }
} } }
```

Restart the tool → ask *"search the docs for X"* or invoke the `doc-read` prompt.

**Starting fresh?** Scaffold a Karpathy-style [LLM wiki](./docs/LLM-WIKI-GUIDE.md):

```bash
bunx doctree-mcp init          # configure current tool
bunx doctree-mcp init --all    # configure every supported client
bunx doctree-mcp init --dry-run
```

Creates `docs/wiki/` (LLM-maintained) + `docs/raw-sources/` (your inputs), writes the MCP config, installs a post-write lint hook, appends wiki conventions to `CLAUDE.md` / `AGENTS.md` / `.cursor/rules/`.

---

## Operation Modes

| Mode | Use when | Guide |
|---|---|---|
| **stdio** (default) | Local dev, agent on your machine | [Client setup](./docs/CLIENTS.md) |
| **HTTP** (Streamable HTTP) | Teams, CI, hosted agents | [Deployment](./docs/DEPLOY.md) — Railway · Fly · Render · Cloudflare Containers · Docker |
| **CLI** | `init`, `lint`, debug-index | [Operation modes](./docs/OPERATION-MODES.md#cli-mode) |

Full decision tree: [Operation Modes](./docs/OPERATION-MODES.md).

---

## How It Works — Retrieve · Curate · Add

```
Agent: "How does token refresh work?"

→ search_documents("token refresh")
  #1  auth/middleware.md § Token Refresh Flow       score: 12.4
  #2  auth/oauth.md       § Refresh Token Lifecycle  score: 8.7

→ get_tree("docs:auth:middleware")
  [n1] # Auth Middleware
    [n4] ## Token Refresh Flow
      [n5] ### Automatic Refresh

→ navigate_tree("docs:auth:middleware", "n4")   ← n4 + descendants
```

**Core read tools** (always on):

| Tool | Purpose |
|---|---|
| `search_documents` | BM25 keyword search + facet filters + glossary expansion (markdown · CSV · JSONL) |
| `get_tree` | Table of contents — headings, word counts, summaries |
| `get_node_content` | Full text of a specific section by node ID |
| `navigate_tree` | A section plus all descendants in one call |
| `lookup_row` | O(1) exact-key lookup for structured data rows (e.g. `PROJ-44`) |

**Wiki write tools** (opt-in with `WIKI_WRITE=1`):

| Tool | Purpose |
|---|---|
| `find_similar` | Duplicate detection with overlap ratios |
| `draft_wiki_entry` | Scaffold: suggested path, inferred frontmatter, glossary hits |
| `write_wiki_entry` | Validated write: path containment, schema, duplicate guards, dry-run |

Safety: path containment · frontmatter validation · duplicate detection · dry-run · overwrite protection.

Deprecated aliases (`list_documents`, `find_files`, `find_symbol`) are superseded by `search_documents` — still functional, no longer recommended.

---

## The Skill + MCP Pattern

Most retrieval tools hand the agent a search box and hope for the best. doctree-mcp hands it a **tree**, and the bundled skills teach it how to walk one.

- **MCP = structural primitives.** `search_documents`, `get_tree`, `navigate_tree`, `get_node_content`, `lookup_row` return tree positions the agent reasons over — not finished answers.
- **Skills = procedural knowledge.** `/doc-read`, `/doc-write`, `/doc-lint` encode breadcrumb drill-down: search → outline → navigate → retrieve. The agent learns the *policy*, not just the API.

That pairing doesn't exist cleanly elsewhere:

| Approach | Primitive | Skill teaches | Gap |
|---|---|---|---|
| Managed hybrid RAG (Cloudflare AI Search, Nia) | Flat chunks + similarity | — | Black-box score, no audit trail |
| Tool-returns-answer (Context7) | 2 tools returning answers | Query shape | Agent can't reason about skipped content |
| Skill-over-CLI (QMD) | CLI over flat search | Query expansion | No tree to navigate |
| **doctree-mcp + `/doc-read`** | **Navigable tree** | **Breadcrumbs, multi-instance routing, wiki compilation** | — |

**Why iterative retrieval wins:**

- **Context rot.** Stuffing a 1M-token window with chunks degrades output. Breadcrumb navigation keeps working memory small.
- **Auditability.** `search_documents → get_tree → navigate_tree → get_node_content` is a replayable trail. A cosine score is not. Regulated domains can ship the former.
- **Progressive disclosure.** Fewer navigable primitives beat tool sprawl (cf. Cloudflare Code Mode).

**Multi-instance = client-side federation.** Register several doctree servers under different names; the `/doc-read` skill encodes the routing policy. Add or remove instances without touching the skill. See [Client setup → Multi-instance routing](./docs/CLIENTS.md#multi-instance-routing).

---

## The LLM Wiki Pattern

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Raw Sources    │     │  The Wiki        │     │  The Schema     │
│  (immutable)    │ ──→ │  (LLM-maintained)│ ←── │  (you define)   │
│  notes · logs   │     │  runbooks · refs │     │  CLAUDE.md rules │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

Inspired by [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Full walkthrough: [docs/LLM-WIKI-GUIDE.md](./docs/LLM-WIKI-GUIDE.md).

---

## Configuration (summary)

```yaml
---
title: "Descriptive Title"
description: "One-line summary — boosts ranking"
tags: [relevant, terms]
type: runbook          # runbook | guide | reference | tutorial | architecture | adr
category: auth
---
```

All non-reserved frontmatter fields become filter facets:

```
search_documents("auth", filters: { type: "runbook", tags: ["production"] })
```

**Common env vars:**

| Variable | Default | Description |
|---|---|---|
| `DOCS_ROOT` | `./docs` | Docs folder |
| `DOCS_GLOB` | `**/*.md` | Comma-separated globs (`**/*.md,**/*.csv,**/*.jsonl`) |
| `DOCS_ROOTS` | — | Weighted multi-collection (`./wiki:1.0,./rfcs:0.5`) |
| `PORT` | `3100` | HTTP mode port |
| `WIKI_WRITE` | *(unset)* | `1` enables write tools |
| `GLOSSARY_PATH` | `$DOCS_ROOT/glossary.json` | Query-expansion glossary |

Full reference: [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

**Glossary** — place `glossary.json` in docs root for bidirectional query expansion:

```json
{ "CLI": ["command line interface"], "K8s": ["kubernetes"] }
```

Acronym definitions like `"TLS (Transport Layer Security)"` are also auto-extracted.

**Structured data** — CSV/JSONL files become documents where each row is a tree node. Column roles (id, title, description, facets, URL) are auto-detected from headers. See [docs/STRUCTURED-DATA.md](./docs/STRUCTURED-DATA.md).

---

## Running from Source

```bash
git clone https://github.com/joesaby/doctree-mcp.git
cd doctree-mcp && bun install

DOCS_ROOT=./docs bun run serve          # stdio
DOCS_ROOT=./docs bun run serve:http     # HTTP (port 3100)
DOCS_ROOT=./docs bun run index          # CLI: inspect indexed output
bun test
```

---

## Performance

| Operation | Time | Token cost |
|---|---|---|
| Full index (900 docs) | 2–5s | 0 |
| Incremental re-index | ~50ms | 0 |
| Search | 5–30ms | ~300–1K tokens |
| Tree outline | <1ms | ~200–800 tokens |

---

## Docs

**Setup & operation**
- [Operation Modes](./docs/OPERATION-MODES.md) — stdio · HTTP · CLI
- [Client Setup](./docs/CLIENTS.md) — Claude Code · Cursor · Windsurf · Codex · OpenCode · Claude Desktop
- [Deployment](./docs/DEPLOY.md) — Railway · Fly.io · Render · Cloudflare Containers · Docker
- [Configuration](./docs/CONFIGURATION.md) — env vars, frontmatter, ranking tuning

**Patterns & concepts**
- [LLM Wiki Guide](./docs/LLM-WIKI-GUIDE.md) — agent-maintained knowledge base walkthrough
- [Structured Data](./docs/STRUCTURED-DATA.md) — CSV / JSONL indexing
- [Architecture & Design](./docs/DESIGN.md) — BM25 internals, tree navigation
- [Competitive Analysis](./docs/COMPETITIVE-ANALYSIS.md) — PageIndex, QMD, GitMCP, Context7, managed RAG

**Source**
- [Prompts](./src/prompts.ts) — MCP prompt templates
- Skills: [`/doc-read`](./.claude/skills/doc-read/SKILL.md) · [`/doc-write`](./.claude/skills/doc-write/SKILL.md) · [`/doc-lint`](./.claude/skills/doc-lint/SKILL.md)

---

## Standing on Shoulders

- **[PageIndex](https://pageindex.ai)** — hierarchical tree navigation
- **[Pagefind](https://pagefind.app)** by [CloudCannon](https://cloudcannon.com) — BM25 scoring, positional index, facets
- **[Bun.markdown](https://bun.sh)** by [Oven](https://oven.sh) — native CommonMark parser
- **[Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — the LLM-maintained wiki pattern

## License

MIT
