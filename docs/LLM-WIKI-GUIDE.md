# LLM Wiki Guide

How to use doctree-mcp as an LLM-maintained wiki — a persistent knowledge base where your AI agent handles the bookkeeping while you curate the sources.

This implements the three-layer architecture from [Andrej Karpathy's LLM wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):

```
┌─────────────────────────────────────┐
│  Layer 3: Schema (human-configured) │  ← CLAUDE.md, wiki conventions
├─────────────────────────────────────┤
│  Layer 2: Wiki (LLM-maintained)     │  ← docs/wiki/ markdown files
├─────────────────────────────────────┤
│  Layer 1: Raw sources (immutable)   │  ← docs/raw-sources/ articles, notes
└─────────────────────────────────────┘
```

---

## Step 1: Initialize

Run in your project root:

```bash
bunx doctree-mcp init
```

This creates the three-layer structure and configures your AI tool:

```
docs/
├── wiki/                 ← LLM-maintained (weight 1.0 in search)
│   └── getting-started.md
└── raw-sources/          ← your inputs, never written by the agent (weight 0.3)
```

It also writes your MCP config, lint hook, and wiki conventions to `CLAUDE.md` (or equivalent for your tool). See the [README setup section](../README.md#setup-by-ai-tool) if you need to configure a tool manually.

---

## Step 2: Ingest raw sources

Drop any file into `docs/raw-sources/` — an article, meeting notes, an incident report, anything. Then ask your agent:

> "Read `docs/raw-sources/[filename]` and create a wiki entry from it."

Your agent will:

```
1. search_documents("topic keywords")
   → Check if similar content already exists

2. find_similar(content)
   → Duplicate check with overlap ratios

3. draft_wiki_entry(topic, raw_content)
   → Suggested path, inferred frontmatter, glossary hits

4. write_wiki_entry(path, frontmatter, content, dry_run: true)
   → Validate first

5. write_wiki_entry(path, frontmatter, content, dry_run: false)
   → Write. New doc is immediately searchable.
```

The agent never touches `docs/raw-sources/` — those files stay immutable as your source of truth.

---

## Step 3: Update existing docs

When your agent calls `find_similar` and finds overlap > 0.35, the correct action is to **update the existing doc**, not create a new one. Here is the full update workflow:

```
1. find_similar(new_content)
   → Returns: [overlap: 0.42] docs:auth:middleware — Auth Middleware
   → ⚠ Consider updating this doc

2. navigate_tree("docs:auth:middleware", root_node_id)
   → Read the full existing document

3. Compose merged content
   → Keep existing sections that don't overlap
   → Replace or expand sections that do overlap
   → Add new sections for genuinely new information

4. write_wiki_entry(
     path: "auth/middleware.md",   ← same path as existing file
     frontmatter: { ... },         ← keep existing, update tags if needed
     content: merged_content,
     overwrite: true               ← required for updates
   )
```

**When to create new vs. update:**
- Same topic, new information → update
- Different topic that happens to share terms → create new (use `allow_duplicate: true` if blocked)
- Significant scope expansion → consider splitting into two docs

---

## Step 4: Lint and maintain

After every `write_wiki_entry` call, the lint hook runs automatically:

```
doctree-mcp lint: 2 issues found

MISSING FRONTMATTER (1):
  auth/tokens.md — missing: description, tags

ORPHANED PAGES (1):
  guides/advanced-config.md — no other docs link here
```

The agent sees this output and can fix issues inline.

For a full wiki audit, use the `doc-lint` MCP prompt (or `/doc-lint` in Claude Code):

> "Audit the wiki for health issues."

The `doc-lint` prompt guides the agent through: orphan detection → stub detection → frontmatter completeness → suggested fixes.

Run the linter manually at any time:

```bash
WIKI_ROOT=./docs/wiki bunx doctree-mcp lint
```

---

## Step 5: Multi-collection search

By default, `bunx doctree-mcp init` configures two collections with different weights:

```
DOCS_ROOTS=./docs/wiki:1.0,./docs/raw-sources:0.3
```

- **wiki** at weight 1.0 — authoritative, curated content ranks highest
- **raw-sources** at weight 0.3 — background context, useful for finding the original source

Add more collections as needed:

```json
"DOCS_ROOTS": "./docs/wiki:1.0,./docs/raw-sources:0.3,./meeting-notes:0.1"
```

Lower-weighted collections are still searchable but won't outrank wiki entries.

---

## Frontmatter best practices

For best search quality:

```yaml
---
title: "Descriptive Title"
description: "One-line summary for search ranking"
tags: [relevant, terms, here]
type: guide        # runbook | guide | reference | tutorial | architecture
category: auth     # any domain-specific grouping
---
```

When frontmatter is missing, doctree-mcp infers what it can:
- **title**: Falls back to first H1, then filename
- **description**: Falls back to first paragraph (200 chars)
- **type**: Auto-inferred from directory name (`runbooks/` → `runbook`)
- **Glossary**: Patterns like "TLS (Transport Layer Security)" are auto-extracted

---

## Example prompts

**Ingest a source:**
> "Read `docs/raw-sources/q1-incident-report.md` and create a runbook page documenting the remediation steps. Cross-reference any existing related runbooks."

**Query the wiki:**
> "What's our authentication flow? Show me the relevant architecture docs."

**Update from new source:**
> "Read `docs/raw-sources/updated-auth-spec.md` and update the wiki to reflect any changes. Check for existing auth docs first."

**Maintenance:**
> "Audit the wiki — find any pages that reference deprecated APIs and suggest updates."
