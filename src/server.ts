/**
 * MCP Server for Markdown Tree Navigation
 *
 * Exposes tools that let an agent perform PageIndex-style reasoning
 * over your markdown repository:
 *
 *   1. list_documents   - Browse the document catalog
 *   2. search_documents - Keyword search across all docs
 *   3. get_tree         - Get hierarchical outline of a document
 *   4. get_node_content - Retrieve text from specific tree nodes
 *   5. navigate_tree    - Get a subtree (node + all descendants)
 *
 * Optional wiki curation tools (WIKI_WRITE=1):
 *   6. find_similar     - Duplicate detection before writing
 *   7. draft_wiki_entry - Structural scaffold for new entries
 *   8. write_wiki_entry - Validated write with safety checks
 *
 * The agent workflow:
 *   search/list → pick doc → get_tree → reason about structure →
 *   get_node_content for the exact section needed
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DocumentStore } from "./store";
import { indexAllCollections } from "./indexer";
import { singleRootConfig } from "./types";
import type { IndexConfig } from "./types";
import type { WikiOptions } from "./curator";
import { registerTools } from "./tools";

// ── Configuration ────────────────────────────────────────────────────

const docs_root = process.env.DOCS_ROOT || "./docs";
const config: IndexConfig = singleRootConfig(docs_root);
config.max_depth = parseInt(process.env.MAX_DEPTH || "6");
config.summary_length = parseInt(process.env.SUMMARY_LENGTH || "200");

// ── Initialize store ─────────────────────────────────────────────────

const store = new DocumentStore();

// ── Create MCP Server ────────────────────────────────────────────────

const server = new McpServer({
  name: "doctree-mcp",
  version: "1.0.0",
});

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

// ── Register tools ──────────────────────────────────────────────────

registerTools(server, store, { wiki });

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
  console.error(`[doctree-mcp] Indexing documents from: ${docs_root}`);

  // Index all documents at startup
  const startTime = Date.now();
  const documents = await indexAllCollections(config);
  store.load(documents);

  // Load glossary if present (glossary.json in docs root)
  const glossaryPath = process.env.GLOSSARY_PATH || join(docs_root, "glossary.json");
  if (existsSync(glossaryPath)) {
    try {
      const glossaryData = await Bun.file(glossaryPath).json();
      store.loadGlossary(glossaryData);
      console.error(`[doctree-mcp] Glossary loaded from ${glossaryPath}`);
    } catch (err: any) {
      console.error(`[doctree-mcp] Warning: Failed to load glossary from ${glossaryPath}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const stats = store.getStats();
  console.error(
    `[doctree-mcp] Ready in ${elapsed}s — ${stats.document_count} docs, ${stats.total_nodes} sections, ${stats.indexed_terms} terms`
  );

  if (wiki) {
    console.error(`[doctree-mcp] Wiki write enabled — root: ${wiki.root}`);
  }

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[doctree-mcp] MCP server running on stdio");
}

main().catch((err) => {
  console.error("[doctree-mcp] Fatal error:", err);
  process.exit(1);
});
