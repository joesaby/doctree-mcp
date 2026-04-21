/**
 * MCP Prompt registrations for doctree-mcp.
 *
 * Prompts are workflow templates discoverable by ANY MCP client
 * (Claude Desktop, Cursor, Windsurf, etc.) — not just Claude Code.
 * They guide agents through the correct tool-chaining patterns for
 * reading and writing documentation.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(
  server: McpServer,
  options?: { wikiEnabled?: boolean }
): void {
  // ── Prompt 1: doc-read ──────────────────────────────────────────────
  server.registerPrompt("doc-read", {
    title: "Read Documentation",
    description:
      "Search and retrieve content from the knowledge base. Guides the agent through: search → browse outline → retrieve specific sections.",
    argsSchema: {
      query: z
        .string()
        .describe("Search query or topic to find in the documentation"),
    },
  }, ({ query }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Find information about: ${query}`,
            "",
            "Follow this workflow using the doctree-mcp tools:",
            "",
            "## Step 1: Pick the right search tool",
            "",
            "- **grep_documents** — you have an EXACT string: error codes, CLI flags, config keys, function names, literal phrases, regex. Fast, deterministic, no stemming.",
            "- **search_documents** — you have a CONCEPT: \"how do we rotate JWTs\", \"on-call escalation\". BM25 + glossary + facets handle fuzzy wording.",
            "- **lookup_row** — you have a structured key (PROJ-44, ITEM-1234). O(1) exact match.",
            "",
            `For "${query}", start with whichever fits. If unsure, prefer grep_documents — it's cheap and deterministic. If it returns zero hits, fall back to search_documents so stemming and glossary expansion can rescue the query.`,
            "",
            "## Step 2: Run the search",
            `search_documents: call with query "${query}". Note doc_id and node_id values. Narrow with filters: { "type": "runbook", "tags": ["auth"] }.`,
            `grep_documents: call with pattern "${query}" (add regex: true for regex patterns). Narrow with path_glob: "**/runbooks/**" or the same filters shape.`,
            "",
            "## Step 3: Browse the outline",
            "Pick the most relevant document and call get_tree with its doc_id.",
            "Read the heading hierarchy to identify which sections are relevant.",
            "Do NOT retrieve everything — pick only what matters based on titles, word counts, and summaries.",
            "",
            "## Step 4: Retrieve specific content",
            "For a section and all its subsections, use navigate_tree(doc_id, node_id) — this is most efficient.",
            "For a few individual sections, use get_node_content(doc_id, [node_id, ...]) — up to 10 at once.",
            "",
            "## Step 5: Follow cross-references",
            "If the content links to other documents, repeat steps 3-4 for those if relevant.",
          ].join("\n"),
        },
      },
    ],
  }));

  // ── Prompt 2: doc-grep ──────────────────────────────────────────────
  server.registerPrompt("doc-grep", {
    title: "Grep Documentation",
    description:
      "Literal or regex scan across indexed content. Use for exact strings (error codes, flags, symbols) where BM25 ranking and stemming would get in the way.",
    argsSchema: {
      pattern: z
        .string()
        .describe("Exact string or regex to scan for across the indexed corpus"),
    },
  }, ({ pattern }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Find occurrences of: ${pattern}`,
            "",
            "This is the grep workflow — use it when you already know the exact string.",
            "For conceptual questions (where wording varies), use the doc-read prompt instead.",
            "",
            "## Step 1: Scan",
            `Call grep_documents(pattern: "${pattern}").`,
            "- Set regex: true if the pattern contains regex metacharacters.",
            "- Set case_insensitive: true for forgiving matches.",
            "- Narrow with path_glob (e.g. '**/runbooks/**') or filters ({ type: 'runbook' }) when the corpus is large.",
            "- Nested quantifiers and lookarounds are rejected — simplify the regex if you see a ReDoS error.",
            "",
            "## Step 2: Read context",
            "Each hit includes a node_id. For the most relevant hits, call:",
            "- get_node_content(doc_id, [node_id]) — read just that section",
            "- navigate_tree(doc_id, node_id) — read that section + all its subsections",
            "",
            "## Step 3: If zero hits",
            `Fall back to search_documents("${pattern}"). Stemming or glossary expansion can rescue terms that don't match literally (e.g. "auth" vs "authentication", "K8s" vs "kubernetes").`,
          ].join("\n"),
        },
      },
    ],
  }));

  // ── Prompt 3: doc-write ─────────────────────────────────────────────
  server.registerPrompt("doc-write", {
    title: "Write Documentation",
    description:
      "Create a new wiki entry with duplicate checking, scaffold generation, and validated writing. Requires WIKI_WRITE=1.",
    argsSchema: {
      topic: z
        .string()
        .describe("Topic or title for the new documentation entry"),
    },
  }, ({ topic }) => {
    if (!options?.wikiEnabled) {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Write documentation about: ${topic}`,
                "",
                "**Wiki write tools are not enabled.** To use this workflow, the MCP server must be configured with WIKI_WRITE=1.",
                "",
                "Add this to your MCP configuration:",
                '  "env": { "DOCS_ROOT": "./docs", "WIKI_WRITE": "1" }',
              ].join("\n"),
            },
          },
        ],
      };
    }

    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Create a new wiki entry about: ${topic}`,
              "",
              "Follow this workflow using the doctree-mcp tools:",
              "",
              "## Step 1: Check for duplicates",
              "Call find_similar with the content you plan to write.",
              "",
              "**If overlap > 0.35 — UPDATE WORKFLOW (don't create a new doc):**",
              "1. Call navigate_tree(doc_id, root_node_id) to read the existing doc fully",
              "2. Identify which sections to update, which to keep",
              "3. Compose the full merged content (existing + new information)",
              `4. Call write_wiki_entry(path: "<existing file path>", ..., overwrite: true)`,
              "   — use the same path as the existing file",
              "",
              "**If overlap < 0.35 — proceed to Step 2 (scaffold a new entry):**",
              "",
              "## Step 2: Generate a scaffold",
              `Call draft_wiki_entry with topic: "${topic}" and your raw_content.`,
              "Review the result:",
              "- Suggested path — adjust if needed (e.g., put runbooks in runbooks/, guides in guides/)",
              "- Inferred frontmatter — type, category, tags from similar docs",
              "- Glossary hits — acronyms detected in the content",
              "",
              "## Step 3: Dry-run validation",
              "Call write_wiki_entry with dry_run: true to validate without writing to disk.",
              "Include complete frontmatter:",
              "- title: Descriptive title (avoid generic names like \"Introduction\")",
              "- description: One-line summary for search ranking",
              "- type: runbook | guide | reference | tutorial | architecture | adr | procedure",
              "- tags: 3-8 relevant terms for discoverability",
              "- category: Domain grouping (e.g., auth, deploy, monitoring)",
              "",
              "## Step 4: Write the entry",
              "If validation passes, call write_wiki_entry with dry_run: false.",
              "Report the resulting doc_id and path.",
              "",
              "## Writing tips",
              "- Define acronyms inline on first use, e.g., \"TLS (Transport Layer Security)\" — these are auto-extracted into the glossary",
              "- Use heading hierarchy (H1 → H2 → H3) — each heading becomes a navigable tree node",
              "- Link to related docs with markdown links — doctree-mcp extracts these as cross-references",
              "- Keep one topic per file — smaller docs score better in search",
            ].join("\n"),
          },
        },
      ],
    };
  });

  // ── Prompt 4: doc-lint ──────────────────────────────────────────────
  server.registerPrompt("doc-lint", {
    title: "Audit Wiki Health",
    description:
      "Audit the wiki for orphaned pages, stubs, and missing frontmatter. Guides the agent through a health check using existing search and navigation tools.",
    argsSchema: {},
  }, () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            "Perform a wiki health audit using the doctree-mcp tools.",
            "",
            "## Step 1: Find orphaned pages",
            "Call list_documents() with no filters.",
            "Look for documents with no cross-references (the 'links to:' field is absent or empty).",
            "These are candidates for orphaned pages — nothing links to them.",
            "",
            "## Step 2: Find stubs",
            "In the list_documents results, look for documents with very low word counts (< 100 words).",
            "Call get_tree on each to confirm they are genuinely sparse.",
            "",
            "## Step 3: Check frontmatter completeness",
            "For any documents flagged in steps 1 or 2, call get_node_content on the root node.",
            "Check whether the content has: title, description, tags, type, category in the frontmatter.",
            "",
            "## Step 4: Report and act",
            "Summarize what you found:",
            "- Orphaned pages: suggest adding cross-references from related docs",
            "- Stubs: suggest expanding with more content or merging into a related doc",
            "- Missing frontmatter: suggest the missing fields based on the content",
            "",
            "For each issue, ask the user whether to fix it now or skip.",
          ].join("\n"),
        },
      },
    ],
  }));
}
