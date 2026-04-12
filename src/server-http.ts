/**
 * HTTP Transport variant of the MCP server
 *
 * Use this when you want to expose the server over HTTP (Streamable HTTP)
 * instead of stdio — useful for remote agents, web apps, or multi-client setups.
 *
 * Usage: DOCS_ROOT=./docs bun run src/server-http.ts
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DocumentStore } from "./store";
import { indexAllCollections } from "./indexer";
import { singleRootConfig } from "./types";
import type { IndexConfig } from "./types";
import type { WikiOptions } from "./curator";
import { registerTools } from "./tools";

const docs_root = process.env.DOCS_ROOT || "./docs";
const config: IndexConfig = singleRootConfig(docs_root);
config.max_depth = parseInt(process.env.MAX_DEPTH || "6");
config.summary_length = parseInt(process.env.SUMMARY_LENGTH || "200");

const PORT = parseInt(process.env.PORT || "3100");

const store = new DocumentStore();

// ── Wiki configuration (opt-in) ─────────────────────────────────────

let wiki: WikiOptions | undefined;
if (process.env.WIKI_WRITE === "1") {
  const wikiRoot = resolve(process.env.WIKI_ROOT || docs_root);
  wiki = {
    root: wikiRoot,
    collectionName: "docs",
    duplicateThreshold: parseFloat(
      process.env.WIKI_DUPLICATE_THRESHOLD || "0.35"
    ),
  };
}

async function main() {
  // Index documents
  console.log(`Indexing from ${docs_root}...`);
  const documents = await indexAllCollections(config);
  store.load(documents);

  // Load glossary if present
  const glossaryPath = process.env.GLOSSARY_PATH || join(docs_root, "glossary.json");
  if (existsSync(glossaryPath)) {
    try {
      const glossaryData = await Bun.file(glossaryPath).json();
      store.loadGlossary(glossaryData);
      console.log(`Glossary loaded from ${glossaryPath}`);
    } catch (err: any) {
      console.warn(`Warning: Failed to load glossary: ${err.message}`);
    }
  }

  const stats = store.getStats();
  console.log(
    `Indexed: ${stats.document_count} docs, ${stats.total_nodes} sections`
  );

  if (wiki) {
    console.log(`Wiki write enabled — root: ${wiki.root}`);
  }

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
        const server = createMcpServer(store, wiki);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
        });

        await server.connect(transport);
        return transport.handleRequest(req);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`MCP HTTP server running on http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
}

/** Factory: creates a configured MCP server instance with all tools */
function createMcpServer(store: DocumentStore, wiki?: WikiOptions): McpServer {
  const server = new McpServer({
    name: "doctree-mcp",
    version: "1.0.0",
  });

  registerTools(server, store, { wiki });

  return server;
}

main().catch(console.error);
