---
name: doc-read
description: Search and retrieve content from the doctree-mcp knowledge base. Use when you need to find information in the indexed markdown docs.
argument-hint: [search query or topic]
---

# Retrieve Documentation

Find and retrieve content from the markdown knowledge base using the doctree-mcp tools.

## Workflow

Follow these steps in order. Do NOT skip the tree step — it lets you target exactly what to read instead of dumping entire documents.

### Step 1: Search or browse

If you have a specific query, search for it:

```
search_documents(query: "$ARGUMENTS")
```

If you're exploring broadly or want to see what's available:

```
list_documents(query: "$ARGUMENTS")
```

Note the `doc_id` and `node_id` values from the results.

### Step 2: Read the document outline

Pick the most relevant document from step 1 and get its structure:

```
get_tree(doc_id: "<doc_id from step 1>")
```

Read the outline carefully. Identify which sections are relevant to the query based on their titles, word counts, and summaries. Do NOT retrieve everything — pick only what matters.

### Step 3: Retrieve specific content

For a single section or a few sections:

```
get_node_content(doc_id: "<doc_id>", node_ids: ["<node_id>", ...])
```

For a section and all its subsections (more efficient than fetching each child):

```
navigate_tree(doc_id: "<doc_id>", node_id: "<parent_node_id>")
```

### Step 4: Follow cross-references

If the retrieved content mentions or links to other documents, repeat steps 2-3 for those documents if the user needs that information.

## Tips

- **Use specific terms** in search queries — BM25 matches keywords, not semantic meaning
- **Use facet filters** to narrow search: `filters: { "type": "runbook", "tags": ["auth"] }`
- **Check search snippets first** — the top 3 results include inline content, which may already answer the question
- **Prefer `navigate_tree` over multiple `get_node_content` calls** when you need a whole section with children
- If search returns no results, try alternative terms or check the glossary — abbreviations like "CLI" expand to "command line interface" automatically
