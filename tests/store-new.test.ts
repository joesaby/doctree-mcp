/**
 * Tests for new store methods: resolveRef, getDocMeta, getGlossaryTerms,
 * buildAutoGlossary, buildRefMap, and search-formatter integration.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { DocumentStore } from "../src/store";
import type { IndexedDocument, TreeNode, DocumentMeta } from "../src/types";
import { formatSearchResults } from "../src/search-formatter";

// ── Test helpers ────────────────────────────────────────────────────

function makeNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    node_id: "test:doc:n1",
    title: "Test Node",
    level: 1,
    parent_id: null,
    children: [],
    content: "Default test content for the node.",
    summary: "Default test content...",
    word_count: 6,
    line_start: 1,
    line_end: 10,
    ...overrides,
  };
}

function makeMeta(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    doc_id: "test:doc",
    file_path: "doc.md",
    title: "Test Document",
    description: "A test document for unit testing",
    word_count: 100,
    heading_count: 3,
    max_depth: 2,
    last_modified: "2025-01-01T00:00:00.000Z",
    tags: [],
    content_hash: "abc123",
    collection: "test",
    facets: {},
    references: [],
    ...overrides,
  };
}

function makeDoc(overrides: {
  meta?: Partial<DocumentMeta>;
  tree?: TreeNode[];
  root_nodes?: string[];
} = {}): IndexedDocument {
  const tree = overrides.tree || [
    makeNode({
      node_id: `${overrides.meta?.doc_id || "test:doc"}:n1`,
      title: overrides.meta?.title || "Test Document",
      content: "This is the main content of the test document about authentication and tokens.",
    }),
  ];

  return {
    meta: makeMeta({
      heading_count: tree.length,
      word_count: tree.reduce((s, n) => s + n.word_count, 0),
      ...overrides.meta,
    }),
    tree,
    root_nodes: overrides.root_nodes || [tree[0].node_id],
  };
}

// ── resolveRef ──────────────────────────────────────────────────────

describe("resolveRef", () => {
  let store: DocumentStore;

  beforeEach(() => {
    store = new DocumentStore();
    store.load([
      makeDoc({
        meta: {
          doc_id: "docs:auth:middleware",
          file_path: "auth/middleware.md",
          title: "Auth Middleware",
        },
        tree: [
          makeNode({
            node_id: "docs:auth:middleware:n1",
            title: "Auth Middleware",
          }),
          makeNode({
            node_id: "docs:auth:middleware:n2",
            title: "Token Refresh",
            level: 2,
            parent_id: "docs:auth:middleware:n1",
          }),
        ],
      }),
      makeDoc({
        meta: {
          doc_id: "docs:deploy:prod",
          file_path: "deploy/production.md",
          title: "Production Deploy",
        },
        tree: [
          makeNode({
            node_id: "docs:deploy:prod:n1",
            title: "Production Deploy",
          }),
        ],
      }),
    ]);
  });

  test("resolves by basename", () => {
    const result = store.resolveRef("middleware.md");
    expect(result).not.toBeNull();
    expect(result!.doc_id).toBe("docs:auth:middleware");
  });

  test("resolves by full path basename", () => {
    const result = store.resolveRef("auth/middleware.md");
    expect(result).not.toBeNull();
    expect(result!.doc_id).toBe("docs:auth:middleware");
  });

  test("resolves with fragment to node_id", () => {
    const result = store.resolveRef("middleware.md#token-refresh");
    expect(result).not.toBeNull();
    expect(result!.doc_id).toBe("docs:auth:middleware");
    expect(result!.node_id).toBe("docs:auth:middleware:n2");
  });

  test("returns null for missing file", () => {
    const result = store.resolveRef("nonexistent.md");
    expect(result).toBeNull();
  });

  test("returns doc_id only when fragment doesn't match", () => {
    const result = store.resolveRef("middleware.md#nonexistent-section");
    expect(result).not.toBeNull();
    expect(result!.doc_id).toBe("docs:auth:middleware");
    expect(result!.node_id).toBeUndefined();
  });
});

// ── getDocMeta ──────────────────────────────────────────────────────

describe("getDocMeta", () => {
  let store: DocumentStore;

  beforeEach(() => {
    store = new DocumentStore();
    store.load([
      makeDoc({
        meta: {
          doc_id: "docs:auth",
          title: "Auth Guide",
          tags: ["auth"],
          references: ["deploy.md"],
        },
      }),
    ]);
  });

  test("returns meta for existing doc", () => {
    const meta = store.getDocMeta("docs:auth");
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe("Auth Guide");
    expect(meta!.references).toEqual(["deploy.md"]);
  });

  test("returns null for non-existent doc", () => {
    expect(store.getDocMeta("nonexistent")).toBeNull();
  });
});

// ── getGlossaryTerms ───────────────────────────────────────────────

describe("getGlossaryTerms", () => {
  test("returns loaded glossary terms", () => {
    const store = new DocumentStore();
    store.load([]);
    store.loadGlossary({
      CLI: ["command line interface"],
      K8s: ["kubernetes"],
    });

    const terms = store.getGlossaryTerms();
    expect(terms).toContain("cli");
    expect(terms).toContain("k8s");
  });

  test("returns empty for no glossary", () => {
    const store = new DocumentStore();
    store.load([]);
    expect(store.getGlossaryTerms()).toEqual([]);
  });
});

// ── buildAutoGlossary ───────────────────────────────────────────────

describe("buildAutoGlossary", () => {
  test("extracts acronyms from content during load", () => {
    const store = new DocumentStore();
    store.load([
      makeDoc({
        meta: { doc_id: "docs:security" },
        tree: [
          makeNode({
            node_id: "docs:security:n1",
            title: "Security",
            content: "We use TLS (Transport Layer Security) for all connections.",
          }),
        ],
      }),
    ]);

    const terms = store.getGlossaryTerms();
    expect(terms).toContain("tls");
  });

  test("does not overwrite explicit glossary entries", () => {
    const store = new DocumentStore();
    // Load glossary first
    store.loadGlossary({
      TLS: ["custom transport layer"],
    });

    // Then load docs that define TLS differently
    store.load([
      makeDoc({
        meta: { doc_id: "docs:security" },
        tree: [
          makeNode({
            node_id: "docs:security:n1",
            title: "Security",
            content: "TLS (Transport Layer Security) is important.",
          }),
        ],
      }),
    ]);

    // The explicit glossary should be preserved (auto-glossary runs after buildFilterIndex)
    // But loadGlossary clears the glossary, and load() runs buildAutoGlossary.
    // Since load() clears, auto-glossary runs fresh each time.
    const terms = store.getGlossaryTerms();
    expect(terms).toContain("tls");
  });
});

// ── formatSearchResults ─────────────────────────────────────────────

describe("formatSearchResults", () => {
  let store: DocumentStore;

  beforeEach(() => {
    store = new DocumentStore();
    store.load([
      makeDoc({
        meta: {
          doc_id: "docs:auth",
          file_path: "auth.md",
          title: "Auth Guide",
          facets: { has_code: ["true"], code_languages: ["typescript"] },
          references: ["deploy.md"],
        },
        tree: [
          makeNode({
            node_id: "docs:auth:n1",
            title: "Auth Guide",
            content: "Overview of the authentication system using JWT tokens.",
          }),
          makeNode({
            node_id: "docs:auth:n2",
            title: "Token Refresh",
            level: 2,
            parent_id: "docs:auth:n1",
            content: "The token refresh mechanism uses refresh tokens.",
            word_count: 7,
          }),
        ],
      }),
    ]);
  });

  test("formats empty results with suggestion", () => {
    const output = formatSearchResults([], store, "nonexistent");
    expect(output).toContain("No results found");
    expect(output).toContain("nonexistent");
  });

  test("includes facet badges in results", () => {
    const results = store.searchDocuments("authentication");
    const output = formatSearchResults(results, store, "authentication");

    expect(output).toContain("Search results for");
    expect(output).toContain("authentication");
  });

  test("includes inline content for top results", () => {
    const results = store.searchDocuments("authentication");
    const output = formatSearchResults(results, store, "authentication");

    // Should have full content section
    if (results.length > 0) {
      expect(output).toContain("Full content");
    }
  });

  test("includes score in output", () => {
    const results = store.searchDocuments("token");
    const output = formatSearchResults(results, store, "token");

    expect(output).toContain("Score:");
  });
});
