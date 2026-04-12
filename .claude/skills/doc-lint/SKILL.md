---
name: doc-lint
description: Audit the doctree-mcp wiki for orphaned pages, stubs, missing frontmatter, and broken links.
---

# Audit Wiki Health

Perform a health check on the doctree-mcp wiki using the available tools.

## Workflow

### Step 1: Find orphaned pages

```
list_documents()
```

Look for documents where the `links to:` field is absent or empty — these have no inbound cross-references from other docs.

### Step 2: Find stubs

In the `list_documents` results, identify documents with very low word counts (under ~100 words). Call `get_tree` on each to confirm they are sparse rather than just compact.

### Step 3: Check frontmatter

For each flagged doc, call `get_node_content(doc_id, [root_node_id])`. Check whether frontmatter includes: `title`, `description`, `tags`, `type`, `category`.

### Step 4: Report and fix

For each issue found, report to the user:

**Orphaned pages:** Suggest adding a cross-reference link from a related doc.
**Stubs:** Suggest either expanding the content or merging it into a related doc.
**Missing frontmatter:** Suggest the missing fields based on the content you read.

Ask the user whether to fix each issue now, or skip.

## Tips

- Run `bunx doctree-mcp-lint` in the terminal for a quick machine-readable summary
- Use `find_similar` if you want to check whether a stub should be merged into another doc
- Cross-references are markdown links — adding `[Auth Guide](../auth/guide.md)` to a doc removes its orphan status
