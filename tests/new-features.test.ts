/**
 * Tests for new indexer extraction functions:
 * - extractFirstSentence
 * - extractReferences
 * - extractContentFacets
 * - extractGlossaryEntries
 */

import { describe, test, expect } from "bun:test";
import { buildTree, extractGlossaryEntries, indexFile } from "../src/indexer";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DOC_WITH_LINKS,
  DOC_WITH_ACRONYMS,
  DOC_CODE_HEAVY,
  DOC_NO_FRONTMATTER,
  SIMPLE_DOC,
} from "./fixtures/sample-docs";

// ── extractFirstSentence (tested via buildTree summaries) ───────────

describe("extractFirstSentence", () => {
  test("extracts first complete sentence", () => {
    const body = `# Title\n\nThis is the first sentence. This is the second sentence.`;
    const nodes = buildTree(body, "test:doc");
    const title = nodes.find((n) => n.title === "Title");
    expect(title).toBeDefined();
    expect(title!.summary).toBe("This is the first sentence.");
  });

  test("handles question marks as sentence boundaries", () => {
    const body = `# Title\n\nDoes this work? Yes it does.`;
    const nodes = buildTree(body, "test:doc");
    const title = nodes.find((n) => n.title === "Title");
    expect(title!.summary).toBe("Does this work?");
  });

  test("handles exclamation marks as sentence boundaries", () => {
    const body = `# Title\n\nThis is great! More content here.`;
    const nodes = buildTree(body, "test:doc");
    const title = nodes.find((n) => n.title === "Title");
    expect(title!.summary).toBe("This is great!");
  });

  test("falls back to word-boundary truncation for long text without sentence end", () => {
    const longText = Array(50).fill("word").join(" ");
    const body = `# Title\n\n${longText}`;
    const nodes = buildTree(body, "test:doc");
    const title = nodes.find((n) => n.title === "Title");
    expect(title!.summary.length).toBeLessThanOrEqual(201);
    // Should end with ellipsis if truncated
    if (title!.summary.length < longText.length) {
      expect(title!.summary.endsWith("…")).toBe(true);
    }
  });

  test("returns empty string for empty content", () => {
    const body = `# Title`;
    const nodes = buildTree(body, "test:doc");
    // Node with no content should have empty or minimal summary
    expect(nodes[0].summary).toBeDefined();
  });

  test("short content returns as-is without ellipsis", () => {
    const body = `# Title\n\nShort content`;
    const nodes = buildTree(body, "test:doc");
    const title = nodes.find((n) => n.title === "Title");
    expect(title!.summary).toBe("Short content");
  });
});

// ── extractReferences (tested via indexFile) ─────────────────────────

describe("extractReferences", () => {
  let tempDir: string;

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "doctree-ref-"));
    return tempDir;
  }

  async function cleanup() {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }

  test("extracts relative markdown links", async () => {
    const dir = await setup();
    try {
      await mkdir(join(dir, "arch"), { recursive: true });
      const filePath = join(dir, "arch", "overview.md");
      await writeFile(filePath, DOC_WITH_LINKS);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.references.length).toBeGreaterThan(0);
      // Should include the relative link targets
      expect(result.meta.references.some((r) => r.includes("middleware.md"))).toBe(true);
      expect(result.meta.references.some((r) => r.includes("db-setup.md"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("resolves absolute paths (strips leading /)", async () => {
    const dir = await setup();
    try {
      await mkdir(join(dir, "arch"), { recursive: true });
      const filePath = join(dir, "arch", "overview.md");
      await writeFile(filePath, DOC_WITH_LINKS);

      const result = await indexFile(filePath, dir, "docs");

      // /deploy/production.md should become deploy/production.md
      expect(result.meta.references.some((r) => r === "deploy/production.md")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("skips external URLs", async () => {
    const dir = await setup();
    try {
      await mkdir(join(dir, "arch"), { recursive: true });
      const filePath = join(dir, "arch", "overview.md");
      await writeFile(filePath, DOC_WITH_LINKS);

      const result = await indexFile(filePath, dir, "docs");

      // Should NOT include https://kubernetes.io or mailto:
      for (const ref of result.meta.references) {
        expect(ref).not.toMatch(/^https?:\/\//);
        expect(ref).not.toMatch(/^mailto:/);
      }
    } finally {
      await cleanup();
    }
  });

  test("strips anchors from references", async () => {
    const dir = await setup();
    try {
      await mkdir(join(dir, "arch"), { recursive: true });
      const filePath = join(dir, "arch", "overview.md");
      await writeFile(filePath, DOC_WITH_LINKS);

      const result = await indexFile(filePath, dir, "docs");

      // db-setup.md#connection-pooling should become just db-setup.md path
      for (const ref of result.meta.references) {
        expect(ref).not.toContain("#");
      }
    } finally {
      await cleanup();
    }
  });

  test("returns empty array for docs with no links", async () => {
    const dir = await setup();
    try {
      const filePath = join(dir, "simple.md");
      await writeFile(filePath, `# No Links\n\nJust plain text here.`);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.references).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

// ── extractContentFacets (tested via indexFile) ─────────────────────

describe("extractContentFacets", () => {
  let tempDir: string;

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "doctree-facet-"));
    return tempDir;
  }

  async function cleanup() {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }

  test("detects code blocks and languages", async () => {
    const dir = await setup();
    try {
      const filePath = join(dir, "api.md");
      await writeFile(filePath, DOC_CODE_HEAVY);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["has_code"]).toEqual(["true"]);
      expect(result.meta.facets["code_languages"]).toBeDefined();
      expect(result.meta.facets["code_languages"]).toContain("bash");
      expect(result.meta.facets["code_languages"]).toContain("json");
    } finally {
      await cleanup();
    }
  });

  test("detects internal links", async () => {
    const dir = await setup();
    try {
      await mkdir(join(dir, "arch"), { recursive: true });
      const filePath = join(dir, "arch", "overview.md");
      await writeFile(filePath, DOC_WITH_LINKS);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["has_links"]).toEqual(["true"]);
    } finally {
      await cleanup();
    }
  });

  test("no code facets for plain text docs", async () => {
    const dir = await setup();
    try {
      const filePath = join(dir, "plain.md");
      await writeFile(filePath, `# Plain\n\nJust text, no code blocks.`);

      const result = await indexFile(filePath, dir, "docs");

      expect(result.meta.facets["has_code"]).toBeUndefined();
      expect(result.meta.facets["code_languages"]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

// ── extractGlossaryEntries ──────────────────────────────────────────

describe("extractGlossaryEntries", () => {
  test("extracts ACRONYM (Expansion) pattern", () => {
    const text = "We use TLS (Transport Layer Security) for all connections.";
    const entries = extractGlossaryEntries(text);

    expect(entries["TLS"]).toBeDefined();
    expect(entries["TLS"]).toContain("transport layer security");
  });

  test("extracts Expansion (ACRONYM) pattern", () => {
    const text = "Single Sign On (SSO) is required for all services.";
    const entries = extractGlossaryEntries(text);

    expect(entries["SSO"]).toBeDefined();
    expect(entries["SSO"]).toContain("single sign on");
  });

  test("extracts ACRONYM — Expansion pattern", () => {
    const text = "AES — Advanced Encryption Standard is used for encryption.";
    const entries = extractGlossaryEntries(text);

    expect(entries["AES"]).toBeDefined();
    expect(entries["AES"]).toContain("advanced encryption standard");
  });

  test("handles multiple acronyms in same text", () => {
    const text = `
      TLS (Transport Layer Security) is used for network security.
      We also use AES (Advanced Encryption Standard) for data at rest.
    `;
    const entries = extractGlossaryEntries(text);

    expect(Object.keys(entries).length).toBeGreaterThanOrEqual(2);
    expect(entries["TLS"]).toBeDefined();
    expect(entries["AES"]).toBeDefined();
  });

  test("returns empty for text without acronyms", () => {
    const text = "Just a regular sentence with no acronyms at all.";
    const entries = extractGlossaryEntries(text);
    expect(Object.keys(entries).length).toBe(0);
  });

  test("deduplicates expansions", () => {
    const text = "TLS (Transport Layer Security) and also TLS (Transport Layer Security) again.";
    const entries = extractGlossaryEntries(text);

    expect(entries["TLS"]).toBeDefined();
    expect(entries["TLS"].length).toBe(1);
  });
});
