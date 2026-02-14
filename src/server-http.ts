/**
 * HTTP Transport variant of the MCP server
 * 
 * Use this when you want to expose the server over HTTP (Streamable HTTP)
 * instead of stdio — useful for remote agents, web apps, or multi-client setups.
 * 
 * Usage: DOCS_ROOT=./docs bun run src/server-http.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DocumentStore } from "./store";
import { indexAllCollections } from "./indexer";
import { singleRootConfig } from "./types";
import type { IndexConfig } from "./types";

const docs_root = process.env.DOCS_ROOT || "./docs";
const config: IndexConfig = singleRootConfig(docs_root);
config.max_depth = parseInt(process.env.MAX_DEPTH || "6");
config.summary_length = parseInt(process.env.SUMMARY_LENGTH || "200");

const PORT = parseInt(process.env.PORT || "3100");

const store = new DocumentStore();

async function main() {
  // Index documents
  console.log(`Indexing from ${docs_root}...`);
  const documents = await indexAllCollections(config);
  store.load(documents);

  const stats = store.getStats();
  console.log(
    `Indexed: ${stats.document_count} docs, ${stats.total_nodes} sections`
  );

  // Create a new MCP server per request for stateless operation
  // In production you'd want session tracking for stateful mode

  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health") {
        return Response.json({
          status: "ok",
          ...store.getStats(),
        });
      }

      // MCP endpoint
      if (url.pathname === "/mcp") {
        // For each incoming request, create server + transport
        // This is the stateless pattern from the MCP SDK docs
        const server = createMcpServer(store);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
        });

        await server.connect(transport);

        // Handle the request through the transport
        return transport.handleRequest(req);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`MCP HTTP server running on http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
}

/** Factory: creates a configured MCP server instance with all tools */
function createMcpServer(store: DocumentStore): McpServer {
  const server = new McpServer({
    name: "doctree-mcp",
    version: "1.0.0",
  });

  // Register the same tools as the stdio server
  // (In a real project, extract tool registration to a shared module)

  const { z } = require("zod");

  server.tool(
    "list_documents",
    "List indexed markdown documents with optional filtering",
    {
      query: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().default(30),
      offset: z.number().default(0),
    },
    async ({ query, tag, limit, offset }: any) => {
      const result = store.listDocuments({ query, tag, limit, offset });
      const summary = result.documents
        .map(
          (d: any) =>
            `• [${d.doc_id}] ${d.title} (${d.heading_count} sections)`
        )
        .join("\n");
      return {
        content: [
          { type: "text" as const, text: `${result.total} documents:\n\n${summary}` },
        ],
      };
    }
  );

  server.tool(
    "search_documents",
    "Search across all documents by keyword",
    {
      query: z.string(),
      doc_id: z.string().optional(),
      limit: z.number().default(15),
    },
    async ({ query, doc_id, limit }: any) => {
      const results = store.searchDocuments(query, { limit, doc_id });
      const formatted = results
        .map(
          (r: any, i: number) =>
            `${i + 1}. [${r.doc_id}] ${r.node_title} — ${r.snippet}`
        )
        .join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text: results.length
              ? `Results for "${query}":\n\n${formatted}`
              : `No results for "${query}"`,
          },
        ],
      };
    }
  );

  server.tool(
    "get_tree",
    "Get document section hierarchy",
    { doc_id: z.string() },
    async ({ doc_id }: any) => {
      const tree = store.getTree(doc_id);
      if (!tree)
        return {
          content: [{ type: "text" as const, text: `Not found: ${doc_id}` }],
        };

      const outline = tree.nodes
        .map(
          (n: any) =>
            `${"  ".repeat(n.level - 1)}[${n.node_id}] ${"#".repeat(n.level)} ${n.title} (${n.word_count}w)`
        )
        .join("\n");
      return {
        content: [
          { type: "text" as const, text: `${tree.title}\n\n${outline}` },
        ],
      };
    }
  );

  server.tool(
    "get_node_content",
    "Get full content of specific sections",
    { doc_id: z.string(), node_ids: z.array(z.string()) },
    async ({ doc_id, node_ids }: any) => {
      const result = store.getNodeContent(doc_id, node_ids);
      if (!result)
        return {
          content: [{ type: "text" as const, text: `Not found: ${doc_id}` }],
        };

      const text = result.nodes
        .map((n: any) => `━━━ ${n.title} [${n.node_id}] ━━━\n\n${n.content}`)
        .join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "navigate_tree",
    "Get a section and all its subsections with content",
    { doc_id: z.string(), node_id: z.string() },
    async ({ doc_id, node_id }: any) => {
      const result = store.getSubtree(doc_id, node_id);
      if (!result)
        return {
          content: [
            { type: "text" as const, text: `Not found: ${doc_id}/${node_id}` },
          ],
        };

      const text = result.nodes
        .map((n: any) => `${"#".repeat(n.level)} ${n.title}\n${n.content}`)
        .join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  return server;
}

main().catch(console.error);
