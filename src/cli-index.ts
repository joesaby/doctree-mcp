/**
 * CLI tool to index documents and inspect the tree output.
 * Useful for debugging and verifying the tree structure before running the server.
 * 
 * Usage:
 *   bun run src/cli-index.ts                          # Index ./docs
 *   bun run src/cli-index.ts --root /path/to/docs     # Custom path
 *   bun run src/cli-index.ts --tree <doc_id>           # Show tree for a doc
 *   bun run src/cli-index.ts --search "query"          # Search indexed docs
 */

import { indexAllCollections } from "./indexer";
import { DocumentStore } from "./store";
import { singleRootConfig } from "./types";
import type { IndexConfig } from "./types";

const args = Bun.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

const docs_root = getArg("root") || process.env.DOCS_ROOT || "./docs";
const config: IndexConfig = singleRootConfig(docs_root);
config.max_depth = 6;
config.summary_length = 200;

async function main() {
  console.log(`\n📁 Indexing: ${docs_root}\n`);

  const documents = await indexAllCollections(config);
  const store = new DocumentStore();
  store.load(documents);

  const stats = store.getStats();
  console.log(`\n📊 Index Stats:`);
  console.log(`   Documents:     ${stats.document_count}`);
  console.log(`   Total nodes:   ${stats.total_nodes}`);
  console.log(`   Total words:   ${stats.total_words.toLocaleString()}`);
  console.log(`   Indexed terms: ${stats.indexed_terms.toLocaleString()}`);

  // Show tree for a specific doc
  const treeDocId = getArg("tree");
  if (treeDocId) {
    console.log(`\n🌳 Tree for: ${treeDocId}\n`);
    const tree = store.getTree(treeDocId);
    if (tree) {
      for (const node of tree.nodes) {
        const indent = "  ".repeat(node.level - 1);
        console.log(
          `${indent}[${node.node_id}] ${"#".repeat(node.level)} ${node.title} (${node.word_count}w)`
        );
        if (node.summary) {
          console.log(`${indent}  → ${node.summary.slice(0, 80)}…`);
        }
      }
    } else {
      console.log(`  Document not found. Available doc_ids:`);
      const list = store.listDocuments({ limit: 20 });
      for (const d of list.documents) {
        console.log(`    ${d.doc_id}`);
      }
    }
  }

  // Run a search
  const query = getArg("search");
  if (query) {
    console.log(`\n🔍 Search: "${query}"\n`);
    const results = store.searchDocuments(query, { limit: 10 });
    if (results.length === 0) {
      console.log("  No results found.");
    } else {
      for (const r of results) {
        console.log(
          `  ${r.score.toFixed(1)} │ [${r.doc_id}] ${r.node_title}`
        );
        console.log(`       ${r.snippet.slice(0, 100)}`);
        console.log();
      }
    }
  }

  // If no specific action, show a sample
  if (!treeDocId && !query) {
    console.log(`\n📋 Sample documents (first 10):\n`);
    const list = store.listDocuments({ limit: 10 });
    for (const d of list.documents) {
      console.log(`  [${d.doc_id}] ${d.title}`);
      console.log(`    ${d.file_path} • ${d.heading_count} sections • ${d.word_count} words`);
    }
    console.log(
      `\n  Use --tree <doc_id> to inspect a document's tree structure`
    );
    console.log(`  Use --search "query" to search across all documents`);
  }
}

main().catch(console.error);
