/**
 * MCP Server for Markdown Tree Navigation
 * 
 * Exposes 5 tools that let an agent perform PageIndex-style reasoning
 * over your markdown repository:
 * 
 *   1. list_documents   - Browse the document catalog
 *   2. search_documents - Keyword search across all docs
 *   3. get_tree         - Get hierarchical outline of a document
 *   4. get_node_content - Retrieve text from specific tree nodes
 *   5. navigate_tree    - Get a subtree (node + all descendants)
 * 
 * The agent workflow:
 *   search/list → pick doc → get_tree → reason about structure →
 *   get_node_content for the exact section needed
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DocumentStore } from "./store";
import { indexDirectory } from "./indexer";
import type { IndexConfig } from "./types";

// ── Configuration ────────────────────────────────────────────────────

const config: IndexConfig = {
  docs_root: process.env.DOCS_ROOT || "./docs",
  glob_pattern: process.env.DOCS_GLOB || "**/*.md",
  max_depth: parseInt(process.env.MAX_DEPTH || "6"),
  summary_length: parseInt(process.env.SUMMARY_LENGTH || "200"),
};

// ── Initialize store ─────────────────────────────────────────────────

const store = new DocumentStore();

// ── Create MCP Server ────────────────────────────────────────────────

const server = new McpServer({
  name: "doctree-mcp",
  version: "1.0.0",
});

// ── Tool 1: list_documents ───────────────────────────────────────────
// Agent uses this to browse the catalog, filter by tag/keyword, paginate.
// This is the entry point — analogous to PageIndex's multi-doc search.

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
          `• [${d.doc_id}] ${d.title} (${d.heading_count} sections, ${d.word_count} words)\n  path: ${d.file_path}${d.tags.length ? `\n  tags: ${d.tags.join(", ")}` : ""}`
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

// ── Tool 2: search_documents ─────────────────────────────────────────
// Cross-document keyword search against node titles and content.
// Returns matching sections with snippets and scores.

server.tool(
  "search_documents",
  "Search across all indexed documents by keyword. Matches against section titles and content. Returns ranked results with snippets. Use this to find which documents and sections are relevant to a topic.",
  {
    query: z
      .string()
      .describe("Search query — use specific terms for best results"),
    doc_id: z
      .string()
      .optional()
      .describe("Limit search to a specific document"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(15)
      .describe("Max results"),
  },
  async ({ query, doc_id, limit }) => {
    const results = store.searchDocuments(query, { limit, doc_id });

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No results found for "${query}". Try broader terms or use list_documents to browse the catalog.`,
          },
        ],
      };
    }

    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. [${r.doc_id}] ${r.doc_title}\n   Section: ${r.node_title} (${r.node_id})\n   Score: ${r.score.toFixed(1)}\n   Snippet: ${r.snippet}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Search results for "${query}" (${results.length} matches):\n\n${formatted}\n\nUse get_tree(doc_id) to see the full structure, or get_node_content(doc_id, [node_id]) to read a specific section.`,
        },
      ],
    };
  }
);

// ── Tool 3: get_tree ─────────────────────────────────────────────────
// Returns the hierarchical outline of a document — the "table of contents"
// that the agent reasons over to decide which sections to read.
// This is the core PageIndex concept.

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

    // Format as indented tree for the agent to reason over
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

// ── Tool 4: get_node_content ─────────────────────────────────────────
// Retrieves the actual text content from specific nodes.
// The agent calls this after examining the tree and deciding which sections
// contain the relevant information.

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

// ── Tool 5: navigate_tree ────────────────────────────────────────────
// Retrieves a node AND all its descendants.
// Useful when the agent wants to read an entire section including subsections.

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

// ── Resources: expose index stats ────────────────────────────────────

server.resource("index-stats", "md-tree://stats", async (uri) => {
  const stats = store.getStats();
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(stats, null, 2),
      },
    ],
  };
});

// ── Startup ──────────────────────────────────────────────────────────

async function main() {
  console.error(`[doctree-mcp] Indexing documents from: ${config.docs_root}`);

  // Index all documents at startup
  const startTime = Date.now();
  const documents = await indexDirectory(config);
  store.load(documents);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const stats = store.getStats();
  console.error(
    `[doctree-mcp] Ready in ${elapsed}s — ${stats.document_count} docs, ${stats.total_nodes} sections, ${stats.indexed_terms} terms`
  );

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[doctree-mcp] MCP server running on stdio");
}

main().catch((err) => {
  console.error("[doctree-mcp] Fatal error:", err);
  process.exit(1);
});
