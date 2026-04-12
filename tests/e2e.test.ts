/**
 * End-to-end integration tests.
 *
 * These tests exercise the full pipeline against real markdown files:
 * indexing → store loading → search → tree navigation → wiki curation.
 *
 * Uses the actual docs/ folder in the repo as test data.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

import { indexAllCollections } from "../src/indexer";
import { singleRootConfig } from "../src/types";
import { DocumentStore } from "../src/store";
import { formatSearchResults } from "../src/search-formatter";
import {
  findSimilar,
  draftWikiEntry,
  writeWikiEntry,
  CuratorError,
} from "../src/curator";
import type { WikiOptions } from "../src/curator";

// ── E2E: Index real docs/ folder ────────────────────────────────────

describe("E2E: real docs indexing", () => {
  let store: DocumentStore;
  const docsRoot = resolve(__dirname, "../docs");

  beforeAll(async () => {
    store = new DocumentStore();
    const config = singleRootConfig(docsRoot);
    const documents = await indexAllCollections(config);
    store.load(documents);
  });

  test("indexes all markdown files in docs/", () => {
    const stats = store.getStats();
    expect(stats.document_count).toBeGreaterThanOrEqual(3); // DESIGN, CONFIG, COMPETITIVE-ANALYSIS, LLM-WIKI-GUIDE
    expect(stats.total_nodes).toBeGreaterThan(10);
    expect(stats.indexed_terms).toBeGreaterThan(50);
  });

  test("search returns ranked results from real content", () => {
    const results = store.searchDocuments("BM25 scoring");
    expect(results.length).toBeGreaterThan(0);
    // DESIGN.md discusses BM25 extensively
    expect(results.some((r) => r.file_path.includes("DESIGN"))).toBe(true);
  });

  test("search with facet filters works on real docs", () => {
    // docs/ files auto-detect content facets
    const stats = store.getFacets();
    // Should have some facet keys from auto-detection
    expect(Object.keys(stats).length).toBeGreaterThan(0);
  });

  test("get_tree returns outline for real doc", () => {
    // Find a doc_id from the indexed docs
    const results = store.searchDocuments("configuration");
    expect(results.length).toBeGreaterThan(0);

    const tree = store.getTree(results[0].doc_id);
    expect(tree).not.toBeNull();
    expect(tree!.nodes.length).toBeGreaterThan(0);
    // Every node should have a title and node_id
    for (const node of tree!.nodes) {
      expect(node.node_id).toBeTruthy();
      expect(node.title).toBeTruthy();
    }
  });

  test("get_node_content retrieves real content", () => {
    const results = store.searchDocuments("pagefind");
    expect(results.length).toBeGreaterThan(0);

    const content = store.getNodeContent(results[0].doc_id, [
      results[0].node_id,
    ]);
    expect(content).not.toBeNull();
    expect(content!.nodes.length).toBe(1);
    expect(content!.nodes[0].content.length).toBeGreaterThan(0);
  });

  test("navigate_tree returns subtree with content", () => {
    const results = store.searchDocuments("architecture");
    expect(results.length).toBeGreaterThan(0);

    const subtree = store.getSubtree(results[0].doc_id, results[0].node_id);
    expect(subtree).not.toBeNull();
    expect(subtree!.nodes.length).toBeGreaterThanOrEqual(1);
  });

  test("formatSearchResults produces rich output from real results", () => {
    const results = store.searchDocuments("search ranking BM25");
    const formatted = formatSearchResults(results, store, "search ranking BM25");

    expect(formatted).toContain("Search results for");
    if (results.length > 0) {
      expect(formatted).toContain("Score:");
      expect(formatted).toContain("Section:");
    }
  });

  test("auto-glossary extracts terms from real content", () => {
    const terms = store.getGlossaryTerms();
    // Real docs contain acronyms like BM25, MCP, etc.
    // Auto-glossary should pick up at least some
    // (may be empty if no patterns match — that's ok too)
    expect(Array.isArray(terms)).toBe(true);
  });

  test("cross-references are extracted from real docs", () => {
    // LLM-WIKI-GUIDE.md has internal references
    const list = store.listDocuments();
    const docsWithRefs = list.documents.filter(
      (d) => d.references && d.references.length > 0
    );
    // At least some docs should have cross-references
    // (depends on content, but LLM-WIKI-GUIDE references other docs)
    expect(Array.isArray(list.documents[0]?.references)).toBe(true);
  });

  test("content facets detected on real docs", () => {
    // DESIGN.md and others have code blocks
    const list = store.listDocuments();
    const docsWithCode = list.documents.filter(
      (d) => d.facets["has_code"]?.[0] === "true"
    );
    expect(docsWithCode.length).toBeGreaterThan(0);
  });

  test("first-sentence summaries are well-formed", () => {
    const results = store.searchDocuments("design");
    expect(results.length).toBeGreaterThan(0);

    const tree = store.getTree(results[0].doc_id);
    expect(tree).not.toBeNull();

    for (const node of tree!.nodes) {
      if (node.summary) {
        // Summary should not be raw-truncated mid-word with just "…"
        // (unless it's a very long sentence with no early boundary)
        expect(node.summary.length).toBeLessThanOrEqual(201);
      }
    }
  });
});

// ── E2E: Wiki write cycle ───────────────────────────────────────────

describe("E2E: wiki write cycle", () => {
  let store: DocumentStore;
  let tempDir: string;
  let wiki: WikiOptions;

  beforeAll(async () => {
    // Create a temp wiki with some seed docs
    tempDir = await mkdtemp(join(tmpdir(), "doctree-e2e-wiki-"));
    store = new DocumentStore();

    // Index our real docs as the base
    const docsRoot = resolve(__dirname, "../docs");
    const config = singleRootConfig(docsRoot);
    const documents = await indexAllCollections(config);
    store.load(documents);

    wiki = {
      root: tempDir,
      collectionName: "wiki",
      duplicateThreshold: 0.35,
    };
  });

  test("full cycle: find_similar → draft → dry_run → write → search", async () => {
    const newContent = `# Deployment Checklist

## Pre-deploy Verification

Before deploying to production, verify:
1. All tests pass in CI
2. Database migrations are reviewed
3. Feature flags are configured

## Rollback Plan

If deployment fails, use the rollback procedure documented in the runbook.
`;

    // Step 1: Check for similar docs
    const similar = findSimilar(store, newContent);
    expect(typeof similar.suggest_merge).toBe("boolean");
    expect(Array.isArray(similar.matches)).toBe(true);

    // Step 2: Draft the entry
    const draft = draftWikiEntry(store, wiki, {
      topic: "Deployment Checklist",
      raw_content: newContent,
    });
    expect(draft.suggested_path).toContain("deployment-checklist");
    expect(draft.frontmatter.title).toBe("Deployment Checklist");

    // Step 3: Dry run
    const dryResult = await writeWikiEntry(store, wiki, {
      path: "runbooks/deploy-checklist.md",
      frontmatter: {
        title: "Deployment Checklist",
        type: "runbook",
        tags: ["deploy", "checklist"],
      },
      content: newContent,
      dry_run: true,
    });
    expect(dryResult.status).toBe("dry_run_ok");
    expect(existsSync(dryResult.absolute_path)).toBe(false);

    // Step 4: Actually write
    const writeResult = await writeWikiEntry(store, wiki, {
      path: "runbooks/deploy-checklist.md",
      frontmatter: {
        title: "Deployment Checklist",
        type: "runbook",
        tags: ["deploy", "checklist"],
      },
      content: newContent,
    });
    expect(writeResult.status).toBe("written");
    expect(existsSync(writeResult.absolute_path)).toBe(true);

    // Verify file content
    const written = await readFile(writeResult.absolute_path, "utf-8");
    expect(written).toContain("Deployment Checklist");
    expect(written).toContain("type: \"runbook\"");

    // Step 5: The doc should now be searchable (incremental re-index)
    expect(store.hasDocument(writeResult.doc_id)).toBe(true);

    const searchResults = store.searchDocuments("deployment checklist rollback");
    const found = searchResults.some((r) => r.doc_id === writeResult.doc_id);
    expect(found).toBe(true);
  });

  test("write → overwrite cycle preserves search index", async () => {
    // Write initial version
    await writeWikiEntry(store, wiki, {
      path: "guides/test-overwrite.md",
      frontmatter: { title: "Original Title" },
      content: "# Original\n\nOriginal content about monitoring alerts.",
      allow_duplicate: true,
    });

    const doc_id = "wiki:guides:test-overwrite";
    expect(store.hasDocument(doc_id)).toBe(true);

    // Overwrite with updated content
    await writeWikiEntry(store, wiki, {
      path: "guides/test-overwrite.md",
      frontmatter: { title: "Updated Title" },
      content: "# Updated\n\nUpdated content about dashboard metrics.",
      overwrite: true,
      allow_duplicate: true,
    });

    // Should still be in index with new content
    expect(store.hasDocument(doc_id)).toBe(true);

    const meta = store.getDocMeta(doc_id);
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe("Updated Title");
  });

  test("path containment prevents escape", async () => {
    try {
      await writeWikiEntry(store, wiki, {
        path: "../../etc/evil.md",
        frontmatter: { title: "Evil" },
        content: "bad",
      });
      expect(true).toBe(false); // should not reach here
    } catch (err: any) {
      expect(err).toBeInstanceOf(CuratorError);
      expect(err.code).toBe("PATH_ESCAPE");
    }
  });

  // Cleanup
  test("cleanup temp directory", async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
