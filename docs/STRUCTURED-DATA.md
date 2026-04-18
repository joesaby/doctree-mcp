# Structured Data (CSV + JSONL)

doctree-mcp indexes CSV and JSONL files alongside markdown. Each file becomes one `IndexedDocument`; each row becomes a `TreeNode`. The same five read tools (`search_documents`, `get_tree`, `get_node_content`, `navigate_tree`, `lookup_row`) work across all three formats.

For end-to-end operation and deployment see [Operation Modes](./OPERATION-MODES.md) and [Deployment](./DEPLOY.md).

---

## Enable it

Add the globs to `DOCS_GLOB`:

```bash
DOCS_GLOB="**/*.md,**/*.csv,**/*.jsonl"
```

Default is `**/*.md` — nothing changes for existing deployments until you opt in.

---

## CSV files

One document per file, one node per row, column roles auto-detected from headers.

| Header pattern | Role | Example |
|---|---|---|
| `issue key`, `key`, `id`, `uuid` | Row identity → enables `lookup_row` | `PROJ-44` |
| `summary`, `title`, `name` | Node title | `API Platform Readiness` |
| `description`, `quick notes`, `objective` | Full-text body (BM25-indexed) | *(free text)* |
| `status`, `team`, `theme`, `architect`, `category` | Filter facets | `Done`, `Cloud Platform` |
| `url`, `link` | External URL metadata | ticket-tracker URL |

Long text fields are truncated at `CSV_MAX_TEXT_LENGTH` (default `2000`) for BM25 indexing; the full value is still returned by `get_node_content`.

---

## JSONL files

One document per file, one node per line. Schema is detected from the first line's keys.

| Key pattern | Role |
|---|---|
| `key`, `id`, `uuid` | Row identity → `lookup_row` |
| `title`, `name`, `summary` | Node title |
| `paths`, `pages`, `references`, `links` | Relation content (searchable + navigable) |
| `status`, `team`, `corpus`, `category`, `tags` | Filter facets |
| `url`, `link` | External URL metadata |

Arrays in relation fields are flattened into child nodes so `navigate_tree` can walk them.

---

## Agent workflow

```
lookup_row("PROJ-44")
  → O(1) exact hit: canonical record from whichever file defines PROJ-44

search_documents("PROJ-44", limit: 5)
  → ranked matches across CSV, JSONL, and markdown — ticket row + every
    wiki page, runbook, or design doc that references it

get_node_content(doc_id, [node_ids])
  → pull the specific rows / sections the agent decided it needs
```

The combination — O(1) key lookup plus BM25 cross-reference — is what makes structured data first-class. A canonical ticket export and a wiki of runbooks about those tickets become one searchable graph.

---

## Cross-referencing with JSONL

Ship a JSONL "index" file that maps keys to related wiki paths:

```jsonl
{"key": "PROJ-44", "paths": ["runbooks/api-readiness.md", "architecture/platform.md"], "status": "active"}
{"key": "PROJ-51", "paths": ["runbooks/oauth-rotation.md"], "status": "done"}
```

Now `search_documents("PROJ-44")` returns both the ticket row (from CSV) and every page listed in the JSONL relations — a breadcrumb path from identifier to narrative without maintaining that mapping inside every markdown file.

---

## Multi-instance pattern

Give each corpus its own doctree instance and let the `/doc-read` skill route:

```json
{
  "mcpServers": {
    "wiki":    { "command": "bunx", "args": ["doctree-mcp"], "env": { "DOCS_ROOT": "./wiki" } },
    "tickets": { "command": "bunx", "args": ["doctree-mcp"],
                  "env": { "DOCS_GLOB": "**/*.csv", "DOCS_ROOT": "./tickets" } },
    "refs":    { "command": "bunx", "args": ["doctree-mcp"],
                  "env": { "DOCS_GLOB": "**/*.jsonl", "DOCS_ROOT": "./refs" } }
  }
}
```

See [The Skill + MCP Pattern](../README.md#the-skill--mcp-pattern) for why client-side federation beats server-side fan-out for this use case.

---

## Configuration reference

| Env var | Default | Description |
|---|---|---|
| `DOCS_GLOB` | `**/*.md` | Comma-separated patterns |
| `CSV_MAX_TEXT_LENGTH` | `2000` | Truncate long CSV text for BM25 |

Background: [design spec](./specs/2026-04-17-structured-data.md).
