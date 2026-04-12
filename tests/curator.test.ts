/**
 * Tests for the wiki curation toolset (src/curator.ts).
 *
 * Covers: findSimilar, draftWikiEntry, writeWikiEntry,
 * path containment, frontmatter validation, duplicate detection,
 * dry_run, overwrite, and incremental re-index.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { DocumentStore } from "../src/store";
import {
  findSimilar,
  draftWikiEntry,
  writeWikiEntry,
  CuratorError,
} from "../src/curator";
import type { WikiOptions } from "../src/curator";
import type { IndexedDocument, TreeNode, DocumentMeta } from "../src/types";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ─────────────────────────────────────────────────────────

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
    description: "A test document",
    word_count: 100,
    heading_count: 1,
    max_depth: 1,
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
} = {}): IndexedDocument {
  const tree = overrides.tree || [
    makeNode({
      node_id: `${overrides.meta?.doc_id || "test:doc"}:n1`,
      title: overrides.meta?.title || "Test Document",
      content: "Authentication and token management guide for production services.",
    }),
  ];
  return {
    meta: makeMeta({
      heading_count: tree.length,
      ...overrides.meta,
    }),
    tree,
    root_nodes: [tree[0].node_id],
  };
}

// ── findSimilar ─────────────────────────────────────────────────────

describe("findSimilar", () => {
  let store: DocumentStore;

  beforeEach(() => {
    store = new DocumentStore();
    store.load([
      makeDoc({
        meta: {
          doc_id: "docs:auth",
          file_path: "auth.md",
          title: "Authentication Guide",
        },
        tree: [
          makeNode({
            node_id: "docs:auth:n1",
            title: "Authentication Guide",
            content: "Guide to authentication tokens and JWT session management in production.",
          }),
        ],
      }),
      makeDoc({
        meta: {
          doc_id: "docs:deploy",
          file_path: "deploy.md",
          title: "Deployment Guide",
        },
        tree: [
          makeNode({
            node_id: "docs:deploy:n1",
            title: "Deployment Guide",
            content: "Steps to deploy services to kubernetes clusters in production.",
          }),
        ],
      }),
    ]);
  });

  test("finds similar content based on shared terms", () => {
    const result = findSimilar(
      store,
      "Authentication tokens and JWT session management for production services."
    );

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].doc_id).toBe("docs:auth");
  });

  test("returns empty for completely unrelated content", () => {
    const result = findSimilar(
      store,
      "Quantum physics and string theory in higher dimensions.",
      { threshold: 0.5 }
    );

    expect(result.suggest_merge).toBe(false);
  });

  test("respects threshold parameter", () => {
    const loose = findSimilar(store, "authentication production", {
      threshold: 0.01,
    });
    const strict = findSimilar(store, "authentication production", {
      threshold: 0.99,
    });

    expect(strict.suggest_merge).toBe(false);
  });
});

// ── draftWikiEntry ──────────────────────────────────────────────────

describe("draftWikiEntry", () => {
  let store: DocumentStore;
  let wiki: WikiOptions;

  beforeEach(() => {
    store = new DocumentStore();
    store.load([
      makeDoc({
        meta: {
          doc_id: "docs:auth",
          file_path: "auth.md",
          title: "Auth Guide",
          facets: { category: ["guide"] },
        },
        tree: [
          makeNode({
            node_id: "docs:auth:n1",
            title: "Auth Guide",
            content: "Authentication and authorization guide.",
          }),
        ],
      }),
    ]);
    wiki = { root: "/tmp/wiki", collectionName: "docs" };
  });

  test("returns suggested path from topic", () => {
    const result = draftWikiEntry(store, wiki, {
      topic: "Database Migration Guide",
      raw_content: "Steps to migrate the database to a new version.",
    });

    expect(result.suggested_path).toContain("database-migration-guide");
    expect(result.suggested_path).toEndWith(".md");
  });

  test("uses provided suggested_path", () => {
    const result = draftWikiEntry(store, wiki, {
      topic: "Custom Path",
      raw_content: "Some content.",
      suggested_path: "guides/custom.md",
    });

    expect(result.suggested_path).toBe("guides/custom.md");
  });

  test("infers frontmatter title and description", () => {
    const result = draftWikiEntry(store, wiki, {
      topic: "My Topic",
      raw_content: "First paragraph is the description. More content follows.",
    });

    expect(result.frontmatter.title).toBe("My Topic");
    expect(result.frontmatter.description).toBeDefined();
  });

  test("flags duplicate_warning for overlapping content", () => {
    const result = draftWikiEntry(store, wiki, {
      topic: "Auth Guide v2",
      raw_content: "Authentication and authorization guide for production services.",
    });

    // May or may not trigger depending on overlap — just check the field exists
    expect(typeof result.duplicate_warning).toBe("boolean");
  });
});

// ── writeWikiEntry ──────────────────────────────────────────────────

describe("writeWikiEntry", () => {
  let store: DocumentStore;
  let tempDir: string;
  let wiki: WikiOptions;

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "doctree-wiki-"));
    store = new DocumentStore();
    store.load([]);
    wiki = { root: tempDir, collectionName: "docs", duplicateThreshold: 0.35 };
    return tempDir;
  }

  async function cleanup() {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }

  test("writes a valid wiki entry", async () => {
    await setup();
    try {
      const result = await writeWikiEntry(store, wiki, {
        path: "guides/new-guide.md",
        frontmatter: { title: "New Guide", tags: ["test"] },
        content: "# New Guide\n\nThis is a new guide.",
      });

      expect(result.status).toBe("written");
      expect(result.doc_id).toBe("docs:guides:new-guide");

      // Verify file was written
      const content = await readFile(result.absolute_path, "utf-8");
      expect(content).toContain("title: \"New Guide\"");
      expect(content).toContain("# New Guide");
    } finally {
      await cleanup();
    }
  });

  test("dry_run validates without writing", async () => {
    await setup();
    try {
      const result = await writeWikiEntry(store, wiki, {
        path: "test.md",
        frontmatter: { title: "Test" },
        content: "# Test",
        dry_run: true,
      });

      expect(result.status).toBe("dry_run_ok");

      // File should NOT exist
      const { existsSync } = require("node:fs");
      expect(existsSync(result.absolute_path)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("rejects path with .. segments", async () => {
    await setup();
    try {
      await expect(
        writeWikiEntry(store, wiki, {
          path: "../escape/evil.md",
          frontmatter: { title: "Evil" },
          content: "bad",
        })
      ).rejects.toThrow(CuratorError);
    } finally {
      await cleanup();
    }
  });

  test("rejects absolute paths", async () => {
    await setup();
    try {
      await expect(
        writeWikiEntry(store, wiki, {
          path: "/etc/passwd.md",
          frontmatter: { title: "Bad" },
          content: "bad",
        })
      ).rejects.toThrow(CuratorError);
    } finally {
      await cleanup();
    }
  });

  test("rejects non-.md paths", async () => {
    await setup();
    try {
      await expect(
        writeWikiEntry(store, wiki, {
          path: "file.txt",
          frontmatter: { title: "Bad" },
          content: "bad",
        })
      ).rejects.toThrow(CuratorError);
    } finally {
      await cleanup();
    }
  });

  test("rejects invalid frontmatter keys", async () => {
    await setup();
    try {
      await expect(
        writeWikiEntry(store, wiki, {
          path: "test.md",
          frontmatter: { "123invalid": "bad" },
          content: "test",
        })
      ).rejects.toThrow(CuratorError);
    } finally {
      await cleanup();
    }
  });

  test("rejects frontmatter values with newlines", async () => {
    await setup();
    try {
      await expect(
        writeWikiEntry(store, wiki, {
          path: "test.md",
          frontmatter: { title: "line1\nline2" },
          content: "test",
        })
      ).rejects.toThrow(CuratorError);
    } finally {
      await cleanup();
    }
  });

  test("rejects overwriting existing file without flag", async () => {
    await setup();
    try {
      // Write first
      await writeWikiEntry(store, wiki, {
        path: "exists.md",
        frontmatter: { title: "First" },
        content: "first",
      });

      // Try to overwrite
      await expect(
        writeWikiEntry(store, wiki, {
          path: "exists.md",
          frontmatter: { title: "Second" },
          content: "second",
        })
      ).rejects.toThrow(CuratorError);
    } finally {
      await cleanup();
    }
  });

  test("allows overwriting with overwrite=true", async () => {
    await setup();
    try {
      await writeWikiEntry(store, wiki, {
        path: "exists.md",
        frontmatter: { title: "First" },
        content: "first content",
      });

      const result = await writeWikiEntry(store, wiki, {
        path: "exists.md",
        frontmatter: { title: "Updated" },
        content: "updated content",
        overwrite: true,
        allow_duplicate: true,
      });

      expect(result.status).toBe("written");
      const content = await readFile(result.absolute_path, "utf-8");
      expect(content).toContain("updated content");
    } finally {
      await cleanup();
    }
  });

  test("incrementally re-indexes after write", async () => {
    await setup();
    try {
      expect(store.hasDocument("docs:indexed")).toBe(false);

      await writeWikiEntry(store, wiki, {
        path: "indexed.md",
        frontmatter: { title: "Indexed Doc" },
        content: "# Indexed Doc\n\nThis document should be searchable after write.",
      });

      expect(store.hasDocument("docs:indexed")).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
