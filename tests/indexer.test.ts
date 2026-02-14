/**
 * Tests for the markdown indexer.
 *
 * Covers: tree building, frontmatter extraction, facet extraction,
 * path-based type inference, and generic title improvement.
 */

import { describe, test, expect } from "bun:test";
import { buildTree } from "../src/indexer";

// We can't directly test private functions exported from indexer,
// so we test them through indexFile or re-implement the logic here
// for unit testing of the public API.

import {
  SIMPLE_DOC,
  DOC_NO_FRONTMATTER,
  DOC_GENERIC_TITLE,
  DOC_WITH_TYPE,
  DOC_MINIMAL,
  DOC_DEEP_NESTING,
  DOC_EMPTY_FRONTMATTER,
  DOC_CODE_HEAVY,
} from "./fixtures/sample-docs";

// ── buildTree tests ─────────────────────────────────────────────────

describe("buildTree", () => {
  test("parses headings into tree nodes", () => {
    const body = `# Main Title

Some content here.

## Section A

Section A content.

## Section B

Section B content.

### Subsection B1

Nested content.
`;
    const nodes = buildTree(body, "test:doc");

    expect(nodes.length).toBeGreaterThanOrEqual(4);
    expect(nodes[0].title).toBe("Main Title");
    expect(nodes[0].level).toBe(1);
  });

  test("builds parent-child relationships", () => {
    const body = `# Parent

## Child 1

## Child 2

### Grandchild
`;
    const nodes = buildTree(body, "test:doc");

    const parent = nodes.find((n) => n.title === "Parent");
    const child1 = nodes.find((n) => n.title === "Child 1");
    const child2 = nodes.find((n) => n.title === "Child 2");
    const grandchild = nodes.find((n) => n.title === "Grandchild");

    expect(parent).toBeDefined();
    expect(child1).toBeDefined();
    expect(child2).toBeDefined();
    expect(grandchild).toBeDefined();

    expect(parent!.children).toContain(child1!.node_id);
    expect(parent!.children).toContain(child2!.node_id);
    expect(child1!.parent_id).toBe(parent!.node_id);
    expect(grandchild!.parent_id).toBe(child2!.node_id);
  });

  test("assigns content to correct nodes", () => {
    const body = `# Title

Title content paragraph.

## Section

Section content paragraph.
`;
    const nodes = buildTree(body, "test:doc");

    const title = nodes.find((n) => n.title === "Title");
    const section = nodes.find((n) => n.title === "Section");

    expect(title).toBeDefined();
    expect(title!.content).toContain("Title content paragraph");
    expect(section).toBeDefined();
    expect(section!.content).toContain("Section content paragraph");
  });

  test("handles document with no headings", () => {
    const body = "Just a plain paragraph with no headings at all.";
    const nodes = buildTree(body, "test:doc");

    expect(nodes.length).toBe(1);
    expect(nodes[0].title).toBe("(document root)");
    expect(nodes[0].level).toBe(0);
    expect(nodes[0].content).toContain("plain paragraph");
  });

  test("tracks word count per node", () => {
    const body = `# Title

One two three four five.

## Section

Six seven eight.
`;
    const nodes = buildTree(body, "test:doc");

    const title = nodes.find((n) => n.title === "Title");
    const section = nodes.find((n) => n.title === "Section");

    expect(title).toBeDefined();
    expect(title!.word_count).toBeGreaterThan(0);
    expect(section).toBeDefined();
    expect(section!.word_count).toBeGreaterThan(0);
  });

  test("generates summary from content", () => {
    const longContent = "word ".repeat(100);
    const body = `# Title\n\n${longContent}`;
    const nodes = buildTree(body, "test:doc");

    expect(nodes[0].summary.length).toBeLessThanOrEqual(201); // 200 + potential "…"
  });

  test("handles deeply nested headings", () => {
    // Strip frontmatter from DOC_DEEP_NESTING
    const body = DOC_DEEP_NESTING.replace(/^---\n[\s\S]*?\n---\n/, "");
    const nodes = buildTree(body, "test:doc");

    const levels = nodes.map((n) => n.level);
    expect(levels).toContain(1);
    expect(levels).toContain(6);
  });

  test("handles code blocks in content", () => {
    const body = DOC_CODE_HEAVY.replace(/^---\n[\s\S]*?\n---\n/, "");
    const nodes = buildTree(body, "test:doc");

    const authEndpoint = nodes.find(
      (n) => n.title === "Authentication Endpoint"
    );
    expect(authEndpoint).toBeDefined();
    // Code block content gets captured (format may vary by parser)
    expect(authEndpoint!.content.length).toBeGreaterThan(0);
  });

  test("node_ids use doc_id prefix", () => {
    const body = `# Title\n\n## Section`;
    const nodes = buildTree(body, "myCollection:my:doc");

    for (const node of nodes) {
      expect(node.node_id).toStartWith("myCollection:my:doc:n");
    }
  });

  test("line_start and line_end are set", () => {
    const body = `# Title\n\nContent.\n\n## Section\n\nMore content.`;
    const nodes = buildTree(body, "test:doc");

    for (const node of nodes) {
      expect(node.line_start).toBeGreaterThan(0);
      expect(node.line_end).not.toBe(-1);
    }
  });
});

// ── indexFile integration tests ─────────────────────────────────────
// These require filesystem, so we create temp files

import { indexFile } from "../src/indexer";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("indexFile", () => {
  let tempDir: string;

  async function setupTempDir() {
    tempDir = await mkdtemp(join(tmpdir(), "doctree-test-"));
    return tempDir;
  }

  async function cleanupTempDir() {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  test("extracts frontmatter title and tags", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "test.md");
      await writeFile(filePath, SIMPLE_DOC);

      const result = await indexFile(filePath, dir, "test");

      expect(result.meta.title).toBe("Auth Middleware Guide");
      expect(result.meta.tags).toEqual(["authentication", "jwt", "security"]);
      expect(result.meta.description).toBe(
        "How to implement token refresh in the auth middleware"
      );
    } finally {
      await cleanupTempDir();
    }
  });

  test("extracts facets from non-reserved frontmatter keys", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "test.md");
      await writeFile(filePath, SIMPLE_DOC);

      const result = await indexFile(filePath, dir, "test");

      expect(result.meta.facets).toHaveProperty("category");
      expect(result.meta.facets["category"]).toEqual(["guide"]);
    } finally {
      await cleanupTempDir();
    }
  });

  test("falls back to H1 title when no frontmatter title", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "test.md");
      await writeFile(filePath, DOC_NO_FRONTMATTER);

      const result = await indexFile(filePath, dir, "test");

      expect(result.meta.title).toBe("Simple Document");
    } finally {
      await cleanupTempDir();
    }
  });

  test("uses (document root) title when no headings exist", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "my-doc.md");
      await writeFile(filePath, "Just plain content with no headings.");

      const result = await indexFile(filePath, dir, "test");

      // When no headings, buildTree creates a root node with level 0
      // and title "(document root)" which matches the level <= 1 check
      expect(result.meta.title).toBe("(document root)");
    } finally {
      await cleanupTempDir();
    }
  });

  test("generates content hash", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "test.md");
      await writeFile(filePath, SIMPLE_DOC);

      const result = await indexFile(filePath, dir, "test");

      expect(result.meta.content_hash).toBeTruthy();
      expect(typeof result.meta.content_hash).toBe("string");
      expect(result.meta.content_hash.length).toBeGreaterThan(0);
    } finally {
      await cleanupTempDir();
    }
  });

  test("same content produces same hash", async () => {
    const dir = await setupTempDir();
    try {
      const file1 = join(dir, "a.md");
      const file2 = join(dir, "b.md");
      await writeFile(file1, SIMPLE_DOC);
      await writeFile(file2, SIMPLE_DOC);

      const r1 = await indexFile(file1, dir, "test");
      const r2 = await indexFile(file2, dir, "test");

      expect(r1.meta.content_hash).toBe(r2.meta.content_hash);
    } finally {
      await cleanupTempDir();
    }
  });

  test("generates doc_id from collection and path", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "auth"), { recursive: true });
      const filePath = join(dir, "auth", "middleware.md");
      await writeFile(filePath, SIMPLE_DOC);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.doc_id).toBe("docs:auth:middleware");
    } finally {
      await cleanupTempDir();
    }
  });

  test("counts headings and words", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "test.md");
      await writeFile(filePath, SIMPLE_DOC);

      const result = await indexFile(filePath, dir, "test");

      expect(result.meta.heading_count).toBeGreaterThan(0);
      expect(result.meta.word_count).toBeGreaterThan(0);
      expect(result.meta.max_depth).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupTempDir();
    }
  });

  test("tracks root_nodes correctly", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "test.md");
      await writeFile(filePath, SIMPLE_DOC);

      const result = await indexFile(filePath, dir, "test");

      expect(result.root_nodes.length).toBeGreaterThan(0);
      for (const rootId of result.root_nodes) {
        const node = result.tree.find((n) => n.node_id === rootId);
        expect(node).toBeDefined();
        expect(node!.parent_id).toBeNull();
      }
    } finally {
      await cleanupTempDir();
    }
  });
});

// ── Path-based type inference tests ─────────────────────────────────

describe("path-based type inference", () => {
  let tempDir: string;

  async function setupTempDir() {
    tempDir = await mkdtemp(join(tmpdir(), "doctree-type-"));
    return tempDir;
  }

  async function cleanupTempDir() {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  test("infers runbook type from runbooks/ directory", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "runbooks"), { recursive: true });
      const filePath = join(dir, "runbooks", "restart.md");
      await writeFile(filePath, DOC_NO_FRONTMATTER);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["type"]).toEqual(["runbook"]);
    } finally {
      await cleanupTempDir();
    }
  });

  test("infers guide type from guides/ directory", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "guides"), { recursive: true });
      const filePath = join(dir, "guides", "setup.md");
      await writeFile(filePath, DOC_NO_FRONTMATTER);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["type"]).toEqual(["guide"]);
    } finally {
      await cleanupTempDir();
    }
  });

  test("infers tutorial type from tutorials/ directory", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "tutorials"), { recursive: true });
      const filePath = join(dir, "tutorials", "beginner.md");
      await writeFile(filePath, DOC_NO_FRONTMATTER);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["type"]).toEqual(["tutorial"]);
    } finally {
      await cleanupTempDir();
    }
  });

  test("infers reference type from reference/ directory", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "reference"), { recursive: true });
      const filePath = join(dir, "reference", "api.md");
      await writeFile(filePath, DOC_NO_FRONTMATTER);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["type"]).toEqual(["reference"]);
    } finally {
      await cleanupTempDir();
    }
  });

  test("infers deployment type from deploy/ directory", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "deploy"), { recursive: true });
      const filePath = join(dir, "deploy", "prod.md");
      await writeFile(filePath, DOC_NO_FRONTMATTER);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["type"]).toEqual(["deployment"]);
    } finally {
      await cleanupTempDir();
    }
  });

  test("infers ops type from ops/ directory", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "ops"), { recursive: true });
      const filePath = join(dir, "ops", "monitoring.md");
      await writeFile(filePath, DOC_NO_FRONTMATTER);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["type"]).toEqual(["operations"]);
    } finally {
      await cleanupTempDir();
    }
  });

  test("infers pipeline type from pipeline/ directory", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "pipeline"), { recursive: true });
      const filePath = join(dir, "pipeline", "ci.md");
      await writeFile(filePath, DOC_NO_FRONTMATTER);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["type"]).toEqual(["pipeline"]);
    } finally {
      await cleanupTempDir();
    }
  });

  test("does not infer type for root-level files", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "readme.md");
      await writeFile(filePath, DOC_NO_FRONTMATTER);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["type"]).toBeUndefined();
    } finally {
      await cleanupTempDir();
    }
  });

  test("does not override explicit type in frontmatter", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "guides"), { recursive: true });
      const filePath = join(dir, "guides", "db.md");
      await writeFile(filePath, DOC_WITH_TYPE); // has type: runbook

      const result = await indexFile(filePath, dir, "docs");

      // Should keep the frontmatter type, not infer "guide"
      expect(result.meta.facets["type"]).toEqual(["runbook"]);
    } finally {
      await cleanupTempDir();
    }
  });

  test("handles nested path inference (e.g. domain/runbooks/file.md)", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "infra", "runbooks"), { recursive: true });
      const filePath = join(dir, "infra", "runbooks", "restart.md");
      await writeFile(filePath, DOC_NO_FRONTMATTER);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["type"]).toEqual(["runbook"]);
    } finally {
      await cleanupTempDir();
    }
  });
});

// ── Generic title improvement tests ─────────────────────────────────

describe("generic title improvement", () => {
  let tempDir: string;

  async function setupTempDir() {
    tempDir = await mkdtemp(join(tmpdir(), "doctree-title-"));
    return tempDir;
  }

  async function cleanupTempDir() {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  test("improves 'Introduction' title with parent directory", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "auth-system"), { recursive: true });
      const filePath = join(dir, "auth-system", "intro.md");
      await writeFile(filePath, DOC_GENERIC_TITLE);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.title).toContain("Auth System");
      expect(result.meta.title).toContain("Introduction");
    } finally {
      await cleanupTempDir();
    }
  });

  test("does not modify non-generic titles", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "auth"), { recursive: true });
      const filePath = join(dir, "auth", "middleware.md");
      await writeFile(filePath, SIMPLE_DOC);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.title).toBe("Auth Middleware Guide");
    } finally {
      await cleanupTempDir();
    }
  });

  test("does not modify root-level generic titles (no parent dir)", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "index.md");
      const doc = `---\ntitle: "index"\n---\n\n# Index\n\nContent.`;
      await writeFile(filePath, doc);

      const result = await indexFile(filePath, dir, "docs");

      // Root-level file has no parent directory to use
      expect(result.meta.title).toBe("index");
    } finally {
      await cleanupTempDir();
    }
  });
});
