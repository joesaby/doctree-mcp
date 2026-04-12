---
name: doc-write
description: Create a new wiki entry in the doctree-mcp knowledge base. Checks for duplicates, generates a scaffold, and writes with validation. Requires WIKI_WRITE=1.
argument-hint: [topic or title for the new entry]
---

# Write Documentation

Create a new markdown document in the knowledge base using the doctree-mcp wiki curation tools.

**Requires `WIKI_WRITE=1` in the MCP server configuration.** If the write tools are unavailable, tell the user to add `"WIKI_WRITE": "1"` to their doctree env config.

## Workflow

Follow these steps in order. Do NOT skip the duplicate check — it prevents content sprawl.

### Step 1: Check for duplicates

Before writing anything, check if similar content already exists:

```
find_similar(content: "<the content you plan to write>")
```

If matches are found with **overlap > 0.35** — **UPDATE WORKFLOW**:

1. **Read the existing doc** — call `navigate_tree(doc_id, root_node_id)` to get the full content
2. **Decide what to keep vs. replace** — identify sections that overlap with your new content
3. **Compose the merged content** — write the full updated markdown (don't just append)
4. **Overwrite** — call `write_wiki_entry` with the same path and `overwrite: true`:

```
write_wiki_entry(
  path: "<same path as existing file>",
  frontmatter: { ... },   ← keep existing frontmatter, update tags if needed
  content: "<full merged content>",
  overwrite: true
)
```

If overlap is **below 0.35** — proceed to Step 2 (scaffold a new entry).

### Step 2: Generate a scaffold

Get suggestions for path, frontmatter, and structure:

```
draft_wiki_entry(
  topic: "$ARGUMENTS",
  raw_content: "<the content to turn into a wiki entry>"
)
```

Review what comes back:
- **Suggested path** — adjust if needed (e.g., put runbooks in `runbooks/`, guides in `guides/`)
- **Inferred frontmatter** — type, category, tags derived from similar docs
- **Glossary hits** — acronyms detected in the content
- **Duplicate warnings** — similar docs that might overlap

### Step 3: Dry-run validation

Validate the entry without writing to disk:

```
write_wiki_entry(
  path: "<path from step 2, adjusted if needed>",
  frontmatter: {
    "title": "<title>",
    "description": "<one-line summary>",
    "type": "<runbook|guide|reference|tutorial|architecture|adr|...>",
    "category": "<domain grouping>",
    "tags": ["<relevant>", "<terms>"]
  },
  content: "<full markdown content>",
  dry_run: true
)
```

Check the result for warnings. Fix any issues before proceeding.

### Step 4: Write the entry

Once validation passes, write for real:

```
write_wiki_entry(
  path: "<same path>",
  frontmatter: { ... },
  content: "<full markdown content>",
  dry_run: false
)
```

Report the resulting `doc_id` and path to the user.

## Frontmatter Guidelines

Always include these fields:

| Field | Required | Notes |
|-------|----------|-------|
| `title` | Yes | Descriptive, avoid generic names like "Introduction" |
| `description` | Yes | One-line summary, used for search ranking |
| `type` | Yes | `runbook`, `guide`, `reference`, `tutorial`, `architecture`, `adr`, `procedure`, etc. |
| `tags` | Yes | 3-8 relevant terms for discoverability |
| `category` | Recommended | Domain grouping (e.g., `auth`, `deploy`, `monitoring`) |

## Tips

- **Define acronyms inline** on first use — e.g., "TLS (Transport Layer Security)" — doctree-mcp auto-extracts these into the glossary
- **Use meaningful directory paths** — `runbooks/deploy.md` auto-infers `type: runbook`
- **Link to related docs** with standard markdown links — doctree-mcp extracts these as cross-references
- **Keep one topic per file** — smaller, focused docs score better in search than long monoliths
- **Use heading hierarchy** (H1 → H2 → H3) — each heading becomes a navigable tree node
