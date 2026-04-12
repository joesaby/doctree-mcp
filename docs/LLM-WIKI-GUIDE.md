# LLM Wiki Guide

How to use doctree-mcp as an LLM-maintained wiki — a persistent knowledge base where your AI agent handles the bookkeeping while you curate the sources.

This guide walks through setting up the three-layer architecture from [Andrej Karpathy's LLM wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) using doctree-mcp with Claude Code, Cursor, or any MCP-compatible tool.

---

## The Idea

Most knowledge management fails because of **maintenance burden**: updating cross-references, keeping pages consistent, filling in gaps. LLMs don't get bored of bookkeeping.

The pattern has three layers:

```
┌─────────────────────────────────────┐
│  Layer 3: Schema (human-configured) │  ← CLAUDE.md, wiki conventions
├─────────────────────────────────────┤
│  Layer 2: Wiki (LLM-maintained)     │  ← markdown files in docs/
├─────────────────────────────────────┤
│  Layer 1: Raw sources (immutable)   │  ← articles, notes, code
└─────────────────────────────────────┘
```

- **You** decide what sources to ingest and what questions to ask
- **The agent** reads sources, writes wiki pages, maintains cross-references, detects duplicates, and keeps everything consistent
- **doctree-mcp** provides the search, navigation, and validated write infrastructure

---

## Step 1: Initialize Your Docs Folder

Create a docs directory with some initial structure:

```bash
mkdir -p docs
```

Add a few seed markdown files to get started. These can be existing documentation, notes, or even empty templates:

```bash
# Example seed structure
mkdir -p docs/guides docs/reference docs/runbooks

cat > docs/guides/getting-started.md << 'EOF'
---
title: "Getting Started"
tags: [onboarding, setup]
type: guide
---

# Getting Started

Welcome to the project. This guide covers initial setup.

## Prerequisites

- Node.js 18+
- Docker installed

## Installation

Clone the repo and install dependencies.
EOF
```

### Frontmatter Best Practices

For best search quality, include frontmatter in your markdown files:

```yaml
---
title: "Descriptive Title"
description: "One-line summary for search ranking"
tags: [relevant, terms, here]
type: guide        # or: runbook, reference, tutorial, architecture
category: auth     # any domain-specific grouping
---
```

When frontmatter is missing, doctree-mcp infers what it can:
- **title**: Falls back to first H1, then filename
- **description**: Falls back to first paragraph (200 chars)
- **type**: Auto-inferred from directory names (`runbooks/` → runbook, `guides/` → guide)
- **Code facets**: Auto-detected from code blocks in content
- **Glossary**: Acronym definitions like "TLS (Transport Layer Security)" are auto-extracted

---

## Step 2: Configure the MCP Server

### For Claude Code

Create `.mcp.json` in your project root:

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

### For Cursor

Create `.cursor/mcp.json`:

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

### For Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bunx",
      "args": ["doctree-mcp"],
      "env": {
        "DOCS_ROOT": "/absolute/path/to/docs",
        "WIKI_WRITE": "1"
      }
    }
  }
}
```

### Read-Only Mode

Omit `WIKI_WRITE` (or set it to anything other than `"1"`) for read-only access. The 5 search/navigation tools work without wiki write enabled. This is the safe default — enable writes only when you want the agent to create documentation.

---

## Step 3: Set Up the Schema

The schema tells your agent how to organize the wiki. For Claude Code, this goes in your `CLAUDE.md`:

```markdown
# Wiki Conventions

When writing documentation to the wiki:

1. **Check for duplicates first** — always call `find_similar` before creating a new page
2. **Use `draft_wiki_entry` to scaffold** — it infers frontmatter from existing docs
3. **Follow the directory structure**:
   - `docs/guides/` — how-to guides and tutorials
   - `docs/reference/` — API docs, config reference
   - `docs/runbooks/` — operational procedures
   - `docs/architecture/` — system design docs
4. **Include frontmatter** — title, description, tags, type, category
5. **Cross-reference** — link to related docs with relative markdown links
6. **Define acronyms inline** — write "TLS (Transport Layer Security)" on first use
```

---

## Step 4: Agent Workflow

### Reading (Search → Reason → Retrieve)

The agent's typical read workflow:

```
1. search_documents("auth token refresh")
   → Gets ranked results with snippets and auto-inlined content

2. get_tree("docs:auth:middleware")
   → Sees the heading hierarchy, decides which sections matter

3. get_node_content("docs:auth:middleware", ["docs:auth:middleware:n4"])
   → Retrieves exactly the section needed
```

### Writing (Check → Draft → Write)

The agent's write workflow with the curation tools:

```
1. find_similar(content)
   → Checks for duplicate/overlapping existing docs
   → Returns overlap ratios and merge suggestions

2. draft_wiki_entry(topic, raw_content)
   → Gets suggested path, inferred frontmatter, glossary hits
   → Sees which existing docs are related

3. write_wiki_entry(path, frontmatter, content)
   → Validates path containment, frontmatter schema
   → Checks for duplicates one more time
   → Writes to disk and incrementally re-indexes
   → New doc is immediately searchable
```

### Example Prompts

**Ingest a source:**
> "Read this incident report and create a runbook page documenting the remediation steps. Cross-reference any existing related runbooks."

**Query the wiki:**
> "What's our authentication flow? Show me the relevant architecture docs."

**Maintenance:**
> "Audit the wiki for any pages that reference deprecated APIs. List them and suggest updates."

---

## Step 5: Safety Features

The wiki curation tools enforce several safety checks:

### Path Containment
All writes are confined to `WIKI_ROOT` (defaults to `DOCS_ROOT`). The agent cannot write outside this directory — paths with `..` segments or absolute paths are rejected.

### Frontmatter Validation
- Keys must match `/^[a-zA-Z][\w-]*$/`
- Values must be string, number, boolean, or string array
- No newlines allowed in values

### Duplicate Detection
Before writing, `write_wiki_entry` checks the new content against all existing docs using BM25 overlap scoring. If overlap exceeds the threshold (default 35%), the write is blocked with a suggestion to merge instead. Set `allow_duplicate=true` to override.

### Dry Run
Call `write_wiki_entry` with `dry_run=true` to validate everything without touching disk. Useful for testing frontmatter and path conventions.

### Overwrite Protection
Existing files cannot be overwritten unless `overwrite=true` is explicitly set.

---

## Auto-Glossary

doctree-mcp automatically extracts acronym definitions from your content. When your docs contain patterns like:

- `TLS (Transport Layer Security)` — acronym first
- `Transport Layer Security (TLS)` — expansion first
- `TLS — Transport Layer Security` — dash pattern

These are added to the search glossary automatically. Searching for "TLS" will also match "transport layer security" and vice versa. No manual `glossary.json` needed (though you can still use one for additional terms).

---

## Tips

1. **Start small** — begin with a few seed docs and let the agent build from there
2. **Review agent-written docs** — check `git diff` after the agent writes. Commit what you approve, revert what you don't
3. **Use tags consistently** — they power faceted search. Establish conventions early
4. **Cross-reference liberally** — the agent sees cross-references in search results and can follow them
5. **Define acronyms on first use** — the auto-glossary picks them up and improves search for everyone
6. **Use `dry_run` first** — when tuning frontmatter conventions, validate with dry_run before committing to disk

---

## Architecture

```
src/
├── indexer.ts          # Markdown → tree nodes + facets + references + glossary extraction
├── store.ts            # In-memory BM25 search + facets + ref map + auto-glossary
├── types.ts            # TypeScript interfaces
├── tools.ts            # MCP tool registrations (shared by stdio + HTTP)
├── search-formatter.ts # Rich search result formatting with inline content
├── curator.ts          # Wiki curation: findSimilar, draftWikiEntry, writeWikiEntry
├── server.ts           # MCP stdio server
└── server-http.ts      # MCP HTTP/Streamable server
```

All indexing and retrieval is deterministic — zero LLM calls at index or search time. The agent provides the intelligence; doctree-mcp provides the infrastructure.
