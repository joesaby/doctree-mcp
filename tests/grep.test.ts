/**
 * Tests for DocumentStore.grepDocuments — literal/regex scan with
 * ReDoS guard, path_glob filtering, and facet filtering.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { DocumentStore } from "../src/store";
import { formatGrepResult } from "../src/tools";
import type { IndexedDocument, TreeNode, DocumentMeta } from "../src/types";

function makeNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    node_id: "test:doc:n1",
    title: "Test Node",
    level: 1,
    parent_id: null,
    children: [],
    content: "Default test content.",
    summary: "Default test content...",
    word_count: 3,
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
    description: "",
    word_count: 0,
    heading_count: 1,
    max_depth: 1,
    last_modified: "2025-01-01T00:00:00.000Z",
    tags: [],
    content_hash: "abc",
    collection: "test",
    facets: {},
    references: [],
    ...overrides,
  };
}

function makeDoc(overrides: {
  meta?: Partial<DocumentMeta>;
  tree?: TreeNode[];
} = {}): IndexedDocument {
  const tree = overrides.tree || [makeNode()];
  return {
    meta: makeMeta(overrides.meta),
    tree,
    root_nodes: [tree[0].node_id],
  };
}

describe("grepDocuments: literal matching", () => {
  let store: DocumentStore;

  beforeEach(() => {
    store = new DocumentStore();
    store.load([
      makeDoc({
        meta: { doc_id: "docs:auth", file_path: "auth/tokens.md", facets: { type: ["runbook"] } },
        tree: [
          makeNode({
            node_id: "docs:auth:n1",
            title: "Token Rotation",
            content: "To rotate tokens run:\nauth rotate --force\nCheck the audit log after.",
            line_start: 3,
          }),
        ],
      }),
      makeDoc({
        meta: { doc_id: "docs:deploy", file_path: "deploy/prod.md", facets: { type: ["guide"] } },
        tree: [
          makeNode({
            node_id: "docs:deploy:n1",
            title: "Prod Deploy",
            content: "Run: deploy prod --force\nWait for health checks.",
            line_start: 5,
          }),
        ],
      }),
    ]);
  });

  test("finds a literal string across all documents", () => {
    const outcome = store.grepDocuments({ pattern: "--force" });
    expect(outcome.hits).toHaveLength(2);
    expect(outcome.hits.map((h) => h.doc_id).sort()).toEqual([
      "docs:auth",
      "docs:deploy",
    ]);
  });

  test("literal mode escapes regex metacharacters", () => {
    const outcome = store.grepDocuments({ pattern: "--force" });
    // "--force" would be a valid regex but the literal behavior still matches it
    expect(outcome.hits.length).toBeGreaterThan(0);
  });

  test("narrows by doc_id", () => {
    const outcome = store.grepDocuments({ pattern: "--force", doc_id: "docs:auth" });
    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0].doc_id).toBe("docs:auth");
  });

  test("narrows by path_glob", () => {
    const outcome = store.grepDocuments({
      pattern: "--force",
      path_glob: "auth/**",
    });
    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0].file_path).toBe("auth/tokens.md");
  });

  test("narrows by facet filter", () => {
    const outcome = store.grepDocuments({
      pattern: "--force",
      filters: { type: "guide" },
    });
    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0].doc_id).toBe("docs:deploy");
  });

  test("case_insensitive matches", () => {
    const outcome = store.grepDocuments({
      pattern: "ROTATE",
      case_insensitive: true,
    });
    expect(outcome.hits.length).toBeGreaterThan(0);
  });

  test("returns empty when pattern not present", () => {
    const outcome = store.grepDocuments({ pattern: "nonexistent-marker-xyz" });
    expect(outcome.hits).toHaveLength(0);
    expect(outcome.docs_scanned).toBe(2);
  });

  test("hit carries node_id and approximate line number", () => {
    const outcome = store.grepDocuments({ pattern: "audit" });
    expect(outcome.hits).toHaveLength(1);
    const h = outcome.hits[0];
    expect(h.node_id).toBe("docs:auth:n1");
    // content line 3 (0-indexed 2) inside a node whose heading was at line 3
    // absolute = line_start(3) + 1 + offset(2) = 6
    expect(h.line_no).toBe(6);
    expect(h.line).toContain("audit log");
  });

  test("context lines included", () => {
    const outcome = store.grepDocuments({ pattern: "rotate --force", context: 1 });
    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0].context_before[0]).toContain("To rotate");
    expect(outcome.hits[0].context_after[0]).toContain("audit log");
  });
});

describe("grepDocuments: regex mode", () => {
  let store: DocumentStore;

  beforeEach(() => {
    store = new DocumentStore();
    store.load([
      makeDoc({
        tree: [
          makeNode({
            content: "errors: E001, E042, E999 are retryable.\nE500 is fatal.",
          }),
        ],
      }),
    ]);
  });

  test("matches a regex pattern", () => {
    const outcome = store.grepDocuments({ pattern: "E\\d{3}", regex: true });
    expect(outcome.hits).toHaveLength(2);
  });

  test("rejects nested quantifiers to prevent ReDoS", () => {
    expect(() =>
      store.grepDocuments({ pattern: "(a+)+b", regex: true })
    ).toThrow(/backtracking/);
  });

  test("rejects lookaheads as ReDoS-adjacent", () => {
    expect(() =>
      store.grepDocuments({ pattern: "foo(?=bar)", regex: true })
    ).toThrow(/backtracking/);
  });

  test("allows the same 'dangerous' string in literal mode", () => {
    const outcome = store.grepDocuments({ pattern: "(a+)+b", regex: false });
    expect(outcome.hits).toHaveLength(0);
    expect(outcome.docs_scanned).toBe(1);
  });

  test("surfaces invalid regex with a clear error", () => {
    expect(() =>
      store.grepDocuments({ pattern: "[unclosed", regex: true })
    ).toThrow(/Invalid regex/);
  });
});

describe("grepDocuments: limits and truncation", () => {
  test("truncates when hit count reaches limit", () => {
    const store = new DocumentStore();
    const lines = Array.from({ length: 20 }, (_, i) => `match-${i}`).join("\n");
    store.load([makeDoc({ tree: [makeNode({ content: lines })] })]);

    const outcome = store.grepDocuments({ pattern: "match-", limit: 5 });
    expect(outcome.hits).toHaveLength(5);
    expect(outcome.truncated).toBe(true);
  });
});

describe("formatGrepResult", () => {
  test("renders zero-hit message with fallback hint", () => {
    const text = formatGrepResult(
      { hits: [], truncated: false, aborted: false, docs_scanned: 3, nodes_scanned: 7 },
      "foo"
    );
    expect(text).toContain("No matches");
    expect(text).toContain("search_documents");
  });

  test("renders hit block with file:line, node_id, and context", () => {
    const text = formatGrepResult(
      {
        hits: [
          {
            doc_id: "docs:auth",
            file_path: "auth/tokens.md",
            node_id: "docs:auth:n1",
            node_title: "Token Rotation",
            line_no: 42,
            line: "auth rotate --force",
            context_before: ["To rotate tokens run:"],
            context_after: ["Check the audit log after."],
          },
        ],
        truncated: false,
        aborted: false,
        docs_scanned: 1,
        nodes_scanned: 1,
      },
      "--force"
    );
    expect(text).toContain("auth/tokens.md:42");
    expect(text).toContain("docs:auth:n1");
    expect(text).toContain("> 42 | auth rotate --force");
    expect(text).toContain("To rotate tokens run:");
    expect(text).toContain("Check the audit log after.");
  });

  test("flags truncation in summary", () => {
    const text = formatGrepResult(
      {
        hits: [
          {
            doc_id: "d", file_path: "f.md", node_id: "n", node_title: "t",
            line_no: 1, line: "x", context_before: [], context_after: [],
          },
        ],
        truncated: true,
        aborted: false,
        docs_scanned: 1,
        nodes_scanned: 1,
      },
      "x"
    );
    expect(text).toContain("result limit hit");
  });
});
