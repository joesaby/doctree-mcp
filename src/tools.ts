/**
 * Shared MCP tool registrations for doctree-mcp.
 *
 * All 5 read tools + optional wiki curation tools are registered here
 * so both stdio and HTTP transports share identical implementations.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DocumentStore } from "./store";
import { formatSearchResults } from "./search-formatter";
import type { WikiOptions } from "./curator";

export function registerTools(
  server: McpServer,
  store: DocumentStore,
  options?: { wiki?: WikiOptions }
): void {
  // ── Tool 1: list_documents ─────────────────────────────────────────
  server.tool(
    "list_documents",
    "List all indexed markdown documents. Filter by tag or keyword in title/path. Returns document metadata without content — use get_tree to explore a specific document's structure.",
    {
      query: z
        .string()
        .optional()
        .describe("Filter documents by keyword in title, description, or path"),
      tag: z
        .string()
        .optional()
        .describe("Filter documents by frontmatter tag"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(30)
        .describe("Max results to return"),
      offset: z
        .number()
        .min(0)
        .default(0)
        .describe("Pagination offset"),
    },
    async ({ query, tag, limit, offset }) => {
      const result = store.listDocuments({ query, tag, limit, offset });

      const summary = result.documents
        .map(
          (d) =>
            `• [${d.doc_id}] ${d.title} (${d.heading_count} sections, ${d.word_count} words)\n  path: ${d.file_path}${d.tags.length ? `\n  tags: ${d.tags.join(", ")}` : ""}${d.references?.length ? `\n  links to: ${d.references.slice(0, 5).join(", ")}${d.references.length > 5 ? ` (+${d.references.length - 5} more)` : ""}` : ""}`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${result.total} documents (showing ${offset + 1}-${Math.min(offset + limit, result.total)}):\n\n${summary}\n\nUse get_tree with a doc_id to explore a document's section hierarchy.`,
          },
        ],
      };
    }
  );

  // ── Tool 2: search_documents ───────────────────────────────────────
  server.tool(
    "search_documents",
    "Search across all indexed documents by keyword. Matches against section titles and content. Returns ranked results with snippets. Use filters to narrow by frontmatter facets (e.g., type, category, tags). Query terms are automatically expanded using the glossary if one is configured.",
    {
      query: z
        .string()
        .describe("Search query — use specific terms for best results"),
      doc_id: z
        .string()
        .optional()
        .describe("Limit search to a specific document"),
      filters: z
        .record(z.union([z.string(), z.array(z.string())]))
        .optional()
        .describe(
          'Facet filters to narrow results. Keys are frontmatter fields (e.g., "type", "tags", "category"). Values can be a string or array of strings. Example: { "type": "runbook", "tags": ["auth", "jwt"] }'
        ),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(15)
        .describe("Max results"),
    },
    async ({ query, doc_id, filters, limit }) => {
      const results = store.searchDocuments(query, { limit, doc_id, filters });
      const formatted = formatSearchResults(results, store, query);

      return {
        content: [
          {
            type: "text" as const,
            text: formatted + (results.length > 0 ? `\n\nUse get_tree(doc_id) to see the full structure, or get_node_content(doc_id, [node_id]) to read a specific section.` : ""),
          },
        ],
      };
    }
  );

  // ── Tool 3: get_tree ───────────────────────────────────────────────
  server.tool(
    "get_tree",
    "Get the hierarchical section tree of a document. Returns an indented outline showing all headings, their node IDs, and word counts. This is the document's 'table of contents' — examine it to identify which sections contain the information you need, then use get_node_content to retrieve specific sections.",
    {
      doc_id: z
        .string()
        .describe("Document ID (from list_documents or search_documents)"),
    },
    async ({ doc_id }) => {
      const tree = store.getTree(doc_id);

      if (!tree) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Document "${doc_id}" not found. Use list_documents to see available documents.`,
            },
          ],
        };
      }

      const outline = tree.nodes
        .map((n) => {
          const indent = "  ".repeat(n.level - 1);
          return `${indent}[${n.node_id}] ${"#".repeat(n.level)} ${n.title} (${n.word_count} words)\n${indent}  ${n.summary ? `Summary: ${n.summary.slice(0, 120)}…` : ""}`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Document: ${tree.title}\nDoc ID: ${tree.doc_id}\nSections: ${tree.nodes.length}\n\n${outline}\n\nTo read a section's full content, call get_node_content("${doc_id}", ["node_id"]).\nTo get a section and all its subsections, call navigate_tree("${doc_id}", "node_id").`,
          },
        ],
      };
    }
  );

  // ── Tool 4: get_node_content ───────────────────────────────────────
  server.tool(
    "get_node_content",
    "Retrieve the full text content of one or more specific sections. Pass the node IDs obtained from get_tree or search_documents. This returns the actual content under those headings.",
    {
      doc_id: z.string().describe("Document ID"),
      node_ids: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe(
          "Array of node IDs to retrieve content for (from get_tree output)"
        ),
    },
    async ({ doc_id, node_ids }) => {
      const result = store.getNodeContent(doc_id, node_ids);

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Document "${doc_id}" not found.`,
            },
          ],
        };
      }

      if (result.nodes.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matching nodes found for IDs: ${node_ids.join(", ")}. Use get_tree("${doc_id}") to see available node IDs.`,
            },
          ],
        };
      }

      const formatted = result.nodes
        .map(
          (n) =>
            `━━━ ${n.title} [${n.node_id}] (H${n.level}) ━━━\n\n${n.content || "(empty section)"}`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: formatted,
          },
        ],
      };
    }
  );

  // ── Tool 5: navigate_tree ─────────────────────────────────────────
  server.tool(
    "navigate_tree",
    "Get a tree node and ALL its descendant sections with full content. Use this when you need to read an entire section including all its subsections. More efficient than calling get_node_content repeatedly for each child.",
    {
      doc_id: z.string().describe("Document ID"),
      node_id: z
        .string()
        .describe("Root node ID — will return this node and all children"),
    },
    async ({ doc_id, node_id }) => {
      const result = store.getSubtree(doc_id, node_id);

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Document "${doc_id}" not found or node "${node_id}" doesn't exist.`,
            },
          ],
        };
      }

      const formatted = result.nodes
        .map((n) => {
          const indent = "  ".repeat(Math.max(0, n.level - result.nodes[0].level));
          return `${indent}${"#".repeat(n.level)} ${n.title} [${n.node_id}]\n${indent}${n.content || "(empty)"}`;
        })
        .join("\n\n");

      const totalWords = result.nodes.reduce((s, n) => s + n.word_count, 0);

      return {
        content: [
          {
            type: "text" as const,
            text: `Subtree: ${result.nodes[0].title} (${result.nodes.length} sections, ${totalWords} words)\n\n${formatted}`,
          },
        ],
      };
    }
  );

  // ── Wiki curation tools (opt-in via WIKI_WRITE=1) ─────────────────
  if (options?.wiki) {
    registerCurationTools(server, store, options.wiki);
  }
}

function registerCurationTools(
  server: McpServer,
  store: DocumentStore,
  wiki: WikiOptions
): void {
  // Lazy import to avoid loading curator unless wiki is enabled
  const { findSimilar, draftWikiEntry, writeWikiEntry } = require("./curator");

  server.tool(
    "find_similar",
    "Check for existing documents similar to proposed content. Returns matches with overlap ratios to help avoid duplicates. Use this before writing new content.",
    {
      content: z
        .string()
        .describe("The content to check for duplicates against existing docs"),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .default(wiki.duplicateThreshold ?? 0.35)
        .describe("Minimum overlap ratio to flag as similar (0-1)"),
    },
    async ({ content, threshold }) => {
      const result = findSimilar(store, content, { threshold });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "draft_wiki_entry",
    "Generate a structural scaffold for a new wiki entry. Returns suggested path, inferred frontmatter (type/category/tags from similar docs), glossary hits, and backlinks. Does NOT write to disk.",
    {
      topic: z.string().describe("Topic or title for the new entry"),
      raw_content: z
        .string()
        .describe("Raw content to be turned into a wiki entry"),
      suggested_path: z
        .string()
        .optional()
        .describe("Optional suggested file path (relative to wiki root)"),
    },
    async ({ topic, raw_content, suggested_path }) => {
      const result = draftWikiEntry(store, wiki, {
        topic,
        raw_content,
        suggested_path,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "write_wiki_entry",
    "Validate and write a new markdown file to the wiki. Enforces path containment, frontmatter schema, and duplicate checks. Set dry_run=true to validate without writing.",
    {
      path: z
        .string()
        .describe("Relative file path within the wiki root (must end in .md)"),
      frontmatter: z
        .record(
          z.union([
            z.string(),
            z.number(),
            z.boolean(),
            z.array(z.string()),
          ])
        )
        .describe("Frontmatter key-value pairs"),
      content: z.string().describe("Markdown content body"),
      dry_run: z
        .boolean()
        .default(false)
        .describe("If true, validate only — do not write to disk"),
      overwrite: z
        .boolean()
        .default(false)
        .describe("If true, allow overwriting an existing file"),
      allow_duplicate: z
        .boolean()
        .default(false)
        .describe("If true, skip duplicate detection"),
    },
    async ({ path, frontmatter, content, dry_run, overwrite, allow_duplicate }) => {
      try {
        const result = await writeWikiEntry(store, wiki, {
          path,
          frontmatter,
          content,
          dry_run,
          overwrite,
          allow_duplicate,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: err.code || "UNKNOWN", message: err.message },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}
