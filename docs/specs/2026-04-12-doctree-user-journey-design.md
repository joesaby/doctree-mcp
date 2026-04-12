# doctree-mcp User Journey Refresh — Design Spec

**Date:** 2026-04-12
**Scope:** Init CLI, lint CLI, README rewrite, LLM-WIKI-GUIDE refresh, doc-write skill update, prompts refresh, curation tool output formatting
**Approach:** B (Init + Docs + Format curation outputs + doc-lint MCP prompt)

---

## Problem Statement

The current project serves two user types — developers connecting existing docs and knowledge workers starting a fresh Karpathy-style LLM wiki — but the README assumes a single linear path and misses:

1. **No init command.** Users must manually create folder structure, write MCP configs, and copy-paste hook configs for their specific AI tool.
2. **No update workflow.** When `find_similar` finds an overlap, neither the skill nor the prompt explains how to update an existing doc.
3. **Schema layer missing from onboarding.** `CLAUDE.md` wiki conventions are only in `LLM-WIKI-GUIDE.md`; new users miss them.
4. **Single-tool README.** No per-tool setup guide for Cursor, Windsurf, Codex, OpenCode.
5. **Raw JSON from curation tools.** `find_similar` and `draft_wiki_entry` return `JSON.stringify` while read tools return formatted text.
6. **No lint workflow.** Karpathy's "Lint" operation (orphans, stubs, missing frontmatter) has no tooling.

---

## Architecture Overview

```
New binaries:
  bunx doctree-mcp-init   ← src/cli-init.ts   (scaffold + configure all AI tools)
  bunx doctree-mcp-lint   ← src/cli-lint.ts   (wiki health check, called by hooks)

Changed files:
  README.md               ← dual entry points + per-tool setup guide
  docs/LLM-WIKI-GUIDE.md  ← init-first, update pattern, lint pattern
  .claude/skills/doc-write/SKILL.md  ← update branch after find_similar
  src/prompts.ts          ← doc-write update branch + new doc-lint prompt
  src/tools.ts            ← rich text output for find_similar + draft_wiki_entry
  package.json            ← two new bin entries
```

No changes to the existing 5 read tools or 3 write tools API signatures.

---

## Section 1: Init CLI (`src/cli-init.ts`)

### Binary name
`doctree-mcp-init` — added to `package.json` `bin` alongside existing `doctree-mcp`.

### Invocation
```bash
bunx doctree-mcp-init           # interactive
bunx doctree-mcp-init --all     # configure all supported tools without prompts
bunx doctree-mcp-init --dry-run # print what would be written, no disk writes
```

### Step-by-step execution

**1. Detect existing AI tool configs**

Check for presence of these markers in the project root:
- `.mcp.json` or `.claude/` → Claude Code
- `.cursor/` → Cursor
- `.windsurf/` or `.windsurfrules` → Windsurf
- `opencode.json` or `.opencode/` → OpenCode
- `AGENTS.md` or `.codex/` → Codex CLI

**2. Prompt for tool selection** (skipped with `--all`)

Multi-select prompt: "Which AI tools do you use in this project?" with detected tools pre-checked.

**3. Scaffold directory structure** (skipped if already exists)

```
docs/
├── wiki/
│   └── getting-started.md    ← starter entry with frontmatter template
└── raw-sources/
    └── .gitkeep
```

`getting-started.md` content:
```markdown
---
title: "Getting Started"
description: "First wiki entry — replace with your content"
type: guide
tags: [setup]
---

# Getting Started

Add your content here. Each heading becomes a navigable section.
```

**4. Write MCP configs** (never overwrites existing files)

| Tool | File | Key config |
|------|------|-----------|
| Claude Code | `.mcp.json` | `DOCS_ROOTS`, `WIKI_WRITE: "1"` |
| Cursor | `.cursor/mcp.json` | same env |
| Windsurf | `.windsurf/mcp.json` | same env |
| OpenCode | `opencode.json` | `"plugin": []` + mcp server block |
| Codex CLI | `.codex/config.toml` | TOML `[mcp_servers.doctree]` block |
| Claude Desktop | prints manual instructions (no project file) |

All configs use:
```json
"env": {
  "DOCS_ROOTS": "./docs/wiki:1.0,./docs/raw-sources:0.3",
  "WIKI_WRITE": "1"
}
```

**5. Write hook configs** (never overwrites existing files)

All hooks call `bunx doctree-mcp-lint` after a wiki write. The hook fires when `write_wiki_entry` is called via MCP.

| Tool | File | Event | Trigger |
|------|------|-------|---------|
| Claude Code | `.claude/settings.json` | `PostToolUse` | matcher: `write_wiki_entry` |
| Cursor | `.cursor/hooks.json` | `afterMCPExecution` | matcher on MCP tool name |
| Windsurf | `.windsurf/hooks.json` | `post_mcp_tool_use` | all MCP tool calls (Windsurf cannot filter by tool name — lint script runs on every MCP call, which is fast and safe) |
| OpenCode | `.opencode/plugins/doctree-lint.js` | `tool.execute.after` | filters on tool name |
| Codex CLI | `.codex/hooks.json` | `PostToolUse` | note: Bash-only currently, MCP hooks not yet supported |

Claude Code hook config written to `.claude/settings.json`:
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "write_wiki_entry",
        "hooks": [{ "type": "command", "command": "bunx doctree-mcp-lint" }]
      }
    ]
  }
}
```

OpenCode uses a JS plugin (not a shell hook config):
```javascript
// .opencode/plugins/doctree-lint.js
export const DoctreeLintPlugin = async ({ $ }) => ({
  "tool.execute.after": async (event) => {
    if (event.tool?.name === "write_wiki_entry") {
      await $`bunx doctree-mcp-lint`
    }
  }
})
```

**6. Write agent instruction files**

| Tool | File | Content |
|------|------|---------|
| Claude Code / Windsurf | `CLAUDE.md` | Appends wiki conventions block |
| Codex CLI | `AGENTS.md` | Creates with wiki conventions |
| Cursor | `.cursor/rules/doctree-wiki.mdc` | Creates with frontmatter + wiki conventions |

Wiki conventions block content (same across all files, formatted for each tool's markdown conventions):
```markdown
## Wiki Conventions (doctree-mcp)

When writing documentation to the wiki:

1. **Check for duplicates first** — always call `find_similar` before creating a new page
2. **Update, don't duplicate** — if overlap > 0.35, read the existing doc with `navigate_tree`, merge, then `write_wiki_entry(overwrite: true)`
3. **Use `draft_wiki_entry` to scaffold** — it infers frontmatter from existing docs
4. **Follow the directory structure**:
   - `docs/wiki/guides/` — how-to guides and tutorials
   - `docs/wiki/reference/` — API docs, config reference
   - `docs/wiki/runbooks/` — operational procedures
5. **Include frontmatter** — title, description, tags, type, category
6. **Cross-reference** — link to related docs with relative markdown links
7. **Define acronyms inline** — "TLS (Transport Layer Security)" on first use
8. **Raw sources are immutable** — never write to `docs/raw-sources/`
```

**7. Print summary**

```
doctree-mcp initialized!

Created:
  docs/wiki/getting-started.md
  docs/raw-sources/.gitkeep
  .mcp.json
  .cursor/mcp.json
  .claude/settings.json (hook: lint after write)
  .cursor/hooks.json (hook: lint after write)
  CLAUDE.md (wiki conventions appended)
  .cursor/rules/doctree-wiki.mdc

Next steps:
  1. Restart your AI tool to pick up the new MCP config
  2. Ask your agent: "Read [article/doc] and create a wiki entry"
  3. Your agent uses: find_similar → draft_wiki_entry → write_wiki_entry
```

### Idempotency
All file writes check for existence first. Existing files are never modified (except `CLAUDE.md`/`AGENTS.md` which get the wiki conventions block *appended* if the block isn't already present).

---

## Section 2: Lint CLI (`src/cli-lint.ts`)

### Binary name
`doctree-mcp-lint` — added to `package.json` `bin`.

### What it checks
Scans `WIKI_ROOT` (env var, defaults to `./docs/wiki`) for:

1. **Missing required frontmatter** — files without `title`, `description`, or `tags`
2. **Stubs** — files with < 100 words of content
3. **Orphaned pages** — files with no inbound markdown links from other wiki docs
4. **Broken cross-references** — markdown links to files that don't exist

### Output format
Plain text, printed to stdout (agents see this as hook output):

```
doctree-mcp lint: 3 issues found

MISSING FRONTMATTER (1):
  docs/wiki/auth/tokens.md — missing: description, tags

STUBS (1):
  docs/wiki/deploy/rollback.md — 43 words (threshold: 100)

ORPHANED PAGES (1):
  docs/wiki/guides/advanced-config.md — no other docs link here

Run /doc-lint for a guided audit with your agent.
```

Exit code 0 always (lint issues are warnings, not errors — don't block the write).

### Environment variables
- `WIKI_ROOT` — directory to scan (default: `./docs/wiki`, falls back to `DOCS_ROOT`)
- `LINT_MIN_WORDS` — stub threshold (default: 100)

---

## Section 3: README Rewrite

### Structure

```
# doctree-mcp
<tagline: Give your AI agent a markdown knowledge base it can search, browse, and write to>

## Quick Start

### Already have docs?
  3-step path: create/point to docs folder → pick tool below → connect

### Starting fresh? (LLM Wiki)
  bunx doctree-mcp-init
  [what it does in 3 bullets]

## Setup by AI Tool
  ### Claude Code    [config snippet] [hook snippet] [skills note]
  ### Cursor         [config snippet] [hook snippet] [rules note]
  ### Windsurf       [config snippet] [hook snippet] [rules note]
  ### Codex CLI      [config snippet] [hook snippet — limited]
  ### OpenCode       [config snippet] [plugin snippet]
  ### Claude Desktop [config snippet] [read-only, no hooks]

## How It Works: Retrieve · Curate · Add
  [existing examples — kept, good]

## The LLM Wiki Pattern
  [existing diagram — kept]
  See docs/LLM-WIKI-GUIDE.md for full walkthrough

## Frontmatter & Glossary
  [compact — kept]

## Multiple Collections
  [compact — kept]

## Running from Source
  [kept]

## Configuration Reference
  [table — kept]

## Docs
  [links — kept + add doc-lint]

## Standing on Shoulders
  [kept]
```

### Key changes from current README
- Remove the linear Step 1/2/3/4 flow — replace with two parallel paths
- "Setup by AI Tool" is the new centerpiece of getting started
- MCP prompts (`doc-read`, `doc-write`, `doc-lint`) mentioned in each tool section
- Claude Code gets skills mention; other tools get MCP prompts mention
- `bunx doctree-mcp-init` appears prominently in the "starting fresh" path
- Schema/`CLAUDE.md` setup is handled by init, so README doesn't need to explain it

---

## Section 4: LLM-WIKI-GUIDE Refresh

### Restructured steps

**Step 1: Initialize** (replaces manual mkdir)
- `bunx doctree-mcp-init` — what it does, what gets created
- Link to README for per-tool setup if init didn't cover their tool

**Step 2: Ingest raw sources**
- Drop a file in `docs/raw-sources/`
- Ask the agent: "Read [file] and create a wiki entry"
- Agent uses: read raw source → `find_similar` → `draft_wiki_entry` → `write_wiki_entry`

**Step 3: Update existing docs** *(new section)*
- What happens when `find_similar` returns overlap > 0.35
- Full cycle: `navigate_tree` existing doc → merge content → `write_wiki_entry(path, ..., overwrite: true)`
- When to create new vs. update: different topic = new, same topic with new info = update

**Step 4: Lint and maintain**
- What the post-write hook outputs
- How to trigger a full audit: use `doc-lint` MCP prompt or `/doc-lint` skill
- What to do with orphaned pages, stubs, missing frontmatter

**Step 5: Multi-collection pattern**
- `DOCS_ROOTS=./docs/wiki:1.0,./docs/raw-sources:0.3`
- Why weights matter: wiki is authoritative, raw sources are background context
- When to add more collections (meeting notes at 0.1, external API docs at 0.5)

Remove: manual MCP config steps (now handled by init), manual CLAUDE.md instructions (now handled by init).

---

## Section 5: doc-write Skill Update

### Change to `SKILL.md`

After Step 1 (find_similar), replace the current "decide whether to update" note with an explicit branch:

**New content:**
```
If overlap > 0.35 — UPDATE WORKFLOW:
1. Read the existing doc: navigate_tree(doc_id, root_node_id)
2. Identify which sections to update vs. keep
3. Compose the full merged content
4. write_wiki_entry(path: <existing path>, ..., overwrite: true)
   — same path as the existing file, overwrite: true

If overlap < 0.35 — proceed to Step 2 (scaffold new entry)
```

---

## Section 6: Prompts Refresh (`src/prompts.ts`)

### `doc-write` prompt
Add update-branch text after the find_similar step:
- "If overlap > 0.35: call navigate_tree to read the existing doc, merge your new content, then write_wiki_entry with overwrite: true and the same path"

### New `doc-lint` prompt
Third prompt registered via `server.registerPrompt("doc-lint", ...)`:
- No required args (audits the whole wiki)
- Guides agent through: `list_documents` (find orphans — docs with no references), `search_documents` with no query (find stubs — low word count results), `get_tree` on flagged docs (check frontmatter completeness)
- Suggests actions for each issue type

---

## Section 7: Curation Tool Output Formatting (`src/tools.ts`)

### `find_similar` — change from JSON to rich text
```
Found 2 similar documents:

  [overlap: 0.42] docs:auth:middleware — Auth Middleware
    Path: docs/wiki/auth/middleware.md
    Suggestion: Consider updating this doc instead of creating a new one.

  [overlap: 0.18] docs:auth:oauth — OAuth Flow
    Path: docs/wiki/auth/oauth.md

No duplicates found above threshold (0.35).
Use navigate_tree("docs:auth:middleware", "<root_node_id>") to read the existing doc.
```

### `draft_wiki_entry` — change from JSON to rich text
```
Wiki Entry Draft

  Suggested path:  docs/wiki/auth/jwt-validation.md
  Inferred type:   reference
  Inferred category: auth
  Suggested tags:  jwt, auth, middleware, validation

  Frontmatter:
    title: "JWT Validation"
    description: "..."
    type: reference
    category: auth
    tags: [jwt, auth, middleware, validation]

  Glossary hits: JWT → "JSON Web Token"

  Related docs (backlinks to include):
    - docs/wiki/auth/middleware.md
    - docs/wiki/auth/oauth.md

  ⚠ Warning: Similar content exists in docs/wiki/auth/middleware.md (overlap: 0.42)
```

### `write_wiki_entry` — no change
Status/error output is already clear structured text.

---

## File Manifest

### New files
| File | Purpose |
|------|---------|
| `src/cli-init.ts` | Init CLI binary |
| `src/cli-lint.ts` | Lint CLI binary |
| `docs/specs/2026-04-12-doctree-user-journey-design.md` | This spec |

### Modified files
| File | Change |
|------|--------|
| `package.json` | Add two `bin` entries |
| `README.md` | Full rewrite |
| `docs/LLM-WIKI-GUIDE.md` | Restructured steps, update pattern, lint pattern |
| `.claude/skills/doc-write/SKILL.md` | Update branch after find_similar |
| `src/prompts.ts` | doc-write update branch + new doc-lint prompt |
| `src/tools.ts` | Rich text output for find_similar + draft_wiki_entry |

### New generated files (written by `bunx doctree-mcp-init`)
`.mcp.json`, `.cursor/mcp.json`, `.windsurf/mcp.json`, `opencode.json`, `.codex/config.toml`, `.claude/settings.json`, `.cursor/hooks.json`, `.windsurf/hooks.json`, `.opencode/plugins/doctree-lint.js`, `.codex/hooks.json`, `CLAUDE.md` (appended), `AGENTS.md`, `.cursor/rules/doctree-wiki.mdc`

---

## Out of Scope

- `lint_wiki` MCP tool (deferred — can add once we know what structured lint output should look like)
- `update_wiki_entry` / partial section update tool (deferred — agent-mediated merge covers the use case)
- Windsurf skills/workflows (no equivalent to Claude Code skills — MCP prompts cover it)
- GUI or web-based init wizard

---

## Testing Plan

- Unit tests for `cli-init.ts`: file generation, idempotency (no overwrites), `--dry-run` output, `--all` flag
- Unit tests for `cli-lint.ts`: each issue type detected correctly, exit code 0 always
- Update existing curator tests for new rich-text output format from `find_similar` + `draft_wiki_entry`
- Manual smoke test: run `bunx doctree-mcp-init` in a fresh directory, verify all configs, restart agent, run full write cycle
