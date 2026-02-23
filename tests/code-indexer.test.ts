/**
 * Tests for the code indexer — AST-based code navigation.
 *
 * Covers: TypeScript parsing, Python parsing, Go (generic) parsing,
 * code → TreeNode mapping, symbol facets, and integration with DocumentStore.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { parseTypeScript } from "../src/parsers/typescript";
import { parsePython } from "../src/parsers/python";
import { parseGeneric } from "../src/parsers/generic";
import { indexCodeFile, isCodeFile } from "../src/code-indexer";
import { DocumentStore } from "../src/store";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  TS_CLASS_WITH_METHODS,
  TS_INTERFACES_AND_TYPES,
  TS_ARROW_FUNCTIONS,
  PY_CLASS_WITH_METHODS,
  GO_STRUCTS_AND_FUNCS,
} from "./fixtures/sample-code";

// ── TypeScript parser tests ─────────────────────────────────────────

describe("parseTypeScript", () => {
  test("extracts class with methods", () => {
    const symbols = parseTypeScript(TS_CLASS_WITH_METHODS, "test:auth");

    const authService = symbols.find((s) => s.name === "AuthService");
    expect(authService).toBeDefined();
    expect(authService!.kind).toBe("class");
    expect(authService!.exported).toBe(true);
    expect(authService!.children_ids.length).toBeGreaterThan(0);

    // Check methods are children
    const methods = symbols.filter((s) => s.parent_id === authService!.id);
    const methodNames = methods.map((m) => m.name);
    expect(methodNames).toContain("constructor");
    expect(methodNames).toContain("authenticate");
    expect(methodNames).toContain("generateToken");
    expect(methodNames).toContain("refreshToken");
  });

  test("extracts interfaces", () => {
    const symbols = parseTypeScript(TS_INTERFACES_AND_TYPES, "test:types");

    const treeNode = symbols.find((s) => s.name === "TreeNode");
    expect(treeNode).toBeDefined();
    expect(treeNode!.kind).toBe("interface");
    expect(treeNode!.exported).toBe(true);

    const searchResult = symbols.find((s) => s.name === "SearchResult");
    expect(searchResult).toBeDefined();
    expect(searchResult!.kind).toBe("interface");
  });

  test("extracts type aliases", () => {
    const symbols = parseTypeScript(TS_INTERFACES_AND_TYPES, "test:types");

    const filterIndex = symbols.find((s) => s.name === "FilterIndex");
    expect(filterIndex).toBeDefined();
    expect(filterIndex!.kind).toBe("type");

    const facetCounts = symbols.find((s) => s.name === "FacetCounts");
    expect(facetCounts).toBeDefined();
    expect(facetCounts!.kind).toBe("type");
  });

  test("extracts enums", () => {
    const symbols = parseTypeScript(TS_INTERFACES_AND_TYPES, "test:types");

    const logLevel = symbols.find((s) => s.name === "LogLevel");
    expect(logLevel).toBeDefined();
    expect(logLevel!.kind).toBe("enum");
  });

  test("extracts standalone functions", () => {
    const symbols = parseTypeScript(TS_CLASS_WITH_METHODS, "test:auth");

    const validateToken = symbols.find((s) => s.name === "validateToken");
    expect(validateToken).toBeDefined();
    expect(validateToken!.kind).toBe("function");
    expect(validateToken!.exported).toBe(true);
    expect(validateToken!.parent_id).toBeNull();
  });

  test("extracts arrow functions", () => {
    const symbols = parseTypeScript(TS_ARROW_FUNCTIONS, "test:utils");

    const greet = symbols.find((s) => s.name === "greet");
    expect(greet).toBeDefined();
    expect(greet!.kind).toBe("function");
    expect(greet!.exported).toBe(true);

    const add = symbols.find((s) => s.name === "add");
    expect(add).toBeDefined();
    expect(add!.kind).toBe("function");
  });

  test("extracts exported constants", () => {
    const symbols = parseTypeScript(TS_CLASS_WITH_METHODS, "test:auth");

    const defaultExpiry = symbols.find((s) => s.name === "DEFAULT_EXPIRY");
    expect(defaultExpiry).toBeDefined();
    expect(defaultExpiry!.kind).toBe("variable");
    expect(defaultExpiry!.exported).toBe(true);
  });

  test("groups imports into single symbol", () => {
    const symbols = parseTypeScript(TS_CLASS_WITH_METHODS, "test:auth");

    const imports = symbols.find((s) => s.kind === "import");
    expect(imports).toBeDefined();
    expect(imports!.name).toBe("imports");
    expect(imports!.content).toContain("import");
  });

  test("sets line numbers correctly", () => {
    const symbols = parseTypeScript(TS_CLASS_WITH_METHODS, "test:auth");

    for (const sym of symbols) {
      expect(sym.line_start).toBeGreaterThan(0);
      expect(sym.line_end).toBeGreaterThanOrEqual(sym.line_start);
    }
  });

  test("class members reference parent", () => {
    const symbols = parseTypeScript(TS_CLASS_WITH_METHODS, "test:auth");

    const authService = symbols.find((s) => s.name === "AuthService");
    const methods = symbols.filter((s) => s.parent_id === authService!.id);

    for (const method of methods) {
      expect(method.parent_id).toBe(authService!.id);
      expect(authService!.children_ids).toContain(method.id);
    }
  });
});

// ── Python parser tests ─────────────────────────────────────────────

describe("parsePython", () => {
  test("extracts class with methods", () => {
    const symbols = parsePython(PY_CLASS_WITH_METHODS, "test:db");

    const dbConn = symbols.find((s) => s.name === "DatabaseConnection");
    expect(dbConn).toBeDefined();
    expect(dbConn!.kind).toBe("class");
    expect(dbConn!.children_ids.length).toBeGreaterThan(0);

    // Check methods
    const methods = symbols.filter((s) => s.parent_id === dbConn!.id);
    const methodNames = methods.map((m) => m.name);
    expect(methodNames).toContain("__init__");
    expect(methodNames).toContain("connect");
    expect(methodNames).toContain("query");
    expect(methodNames).toContain("close");
  });

  test("extracts decorated class", () => {
    const symbols = parsePython(PY_CLASS_WITH_METHODS, "test:db");

    const config = symbols.find((s) => s.name === "Config");
    expect(config).toBeDefined();
    expect(config!.kind).toBe("class");
    expect(config!.signature).toContain("@dataclass");
  });

  test("extracts standalone functions", () => {
    const symbols = parsePython(PY_CLASS_WITH_METHODS, "test:db");

    const createPool = symbols.find((s) => s.name === "create_pool");
    expect(createPool).toBeDefined();
    expect(createPool!.kind).toBe("function");
    expect(createPool!.parent_id).toBeNull();
    // Public (no leading underscore)
    expect(createPool!.exported).toBe(true);
  });

  test("marks private functions as non-exported", () => {
    const symbols = parsePython(PY_CLASS_WITH_METHODS, "test:db");

    const helper = symbols.find((s) => s.name === "_internal_helper");
    expect(helper).toBeDefined();
    expect(helper!.exported).toBe(false);
  });

  test("extracts module-level constants", () => {
    const symbols = parsePython(PY_CLASS_WITH_METHODS, "test:db");

    const retryCount = symbols.find((s) => s.name === "RETRY_COUNT");
    expect(retryCount).toBeDefined();
    expect(retryCount!.kind).toBe("variable");
  });

  test("groups imports", () => {
    const symbols = parsePython(PY_CLASS_WITH_METHODS, "test:db");

    const imports = symbols.find((s) => s.kind === "import");
    expect(imports).toBeDefined();
    expect(imports!.content).toContain("import");
  });
});

// ── Generic (Go) parser tests ───────────────────────────────────────

describe("parseGeneric (Go)", () => {
  test("extracts structs", () => {
    const symbols = parseGeneric(GO_STRUCTS_AND_FUNCS, "test:go", ".go");

    const tokenService = symbols.find((s) => s.name === "TokenService");
    expect(tokenService).toBeDefined();
    expect(tokenService!.kind).toBe("class"); // struct maps to class
    expect(tokenService!.exported).toBe(true); // uppercase = exported in Go
  });

  test("extracts functions", () => {
    const symbols = parseGeneric(GO_STRUCTS_AND_FUNCS, "test:go", ".go");

    const newTokenService = symbols.find((s) => s.name === "NewTokenService");
    expect(newTokenService).toBeDefined();
    expect(newTokenService!.kind).toBe("function");
    expect(newTokenService!.exported).toBe(true);
  });

  test("extracts Go imports", () => {
    const symbols = parseGeneric(GO_STRUCTS_AND_FUNCS, "test:go", ".go");

    const imports = symbols.find((s) => s.kind === "import");
    expect(imports).toBeDefined();
    expect(imports!.content).toContain("context");
  });

  test("extracts Go var declarations", () => {
    const symbols = parseGeneric(GO_STRUCTS_AND_FUNCS, "test:go", ".go");

    const errExpired = symbols.find((s) => s.name === "ErrExpired");
    expect(errExpired).toBeDefined();
    expect(errExpired!.kind).toBe("variable");
    expect(errExpired!.exported).toBe(true); // uppercase
  });
});

// ── isCodeFile utility ──────────────────────────────────────────────

describe("isCodeFile", () => {
  test("recognizes TypeScript files", () => {
    expect(isCodeFile("auth.ts")).toBe(true);
    expect(isCodeFile("component.tsx")).toBe(true);
    expect(isCodeFile("server.mts")).toBe(true);
  });

  test("recognizes JavaScript files", () => {
    expect(isCodeFile("app.js")).toBe(true);
    expect(isCodeFile("config.mjs")).toBe(true);
  });

  test("recognizes Python files", () => {
    expect(isCodeFile("main.py")).toBe(true);
    expect(isCodeFile("types.pyi")).toBe(true);
  });

  test("recognizes Go files", () => {
    expect(isCodeFile("main.go")).toBe(true);
  });

  test("recognizes Rust files", () => {
    expect(isCodeFile("lib.rs")).toBe(true);
  });

  test("rejects non-code files", () => {
    expect(isCodeFile("readme.md")).toBe(false);
    expect(isCodeFile("data.json")).toBe(false);
    expect(isCodeFile("style.css")).toBe(false);
    expect(isCodeFile("image.png")).toBe(false);
  });
});

// ── indexCodeFile integration tests ─────────────────────────────────

describe("indexCodeFile", () => {
  let tempDir: string;

  async function setupTempDir() {
    tempDir = await mkdtemp(join(tmpdir(), "doctree-code-test-"));
    return tempDir;
  }

  async function cleanupTempDir() {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  test("indexes TypeScript file into IndexedDocument", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "auth.ts");
      await writeFile(filePath, TS_CLASS_WITH_METHODS);

      const result = await indexCodeFile(filePath, dir, "code");

      expect(result.meta.doc_id).toBe("code:auth");
      expect(result.meta.title).toBe("auth.ts");
      expect(result.meta.facets.language).toEqual(["typescript"]);
      expect(result.meta.facets.content_type).toEqual(["code"]);
      expect(result.meta.facets.symbol_kind).toBeDefined();
      expect(result.tree.length).toBeGreaterThan(0);
      expect(result.root_nodes.length).toBeGreaterThan(0);
    } finally {
      await cleanupTempDir();
    }
  });

  test("indexes Python file into IndexedDocument", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "db.py");
      await writeFile(filePath, PY_CLASS_WITH_METHODS);

      const result = await indexCodeFile(filePath, dir, "code");

      expect(result.meta.doc_id).toBe("code:db");
      expect(result.meta.facets.language).toEqual(["python"]);
      expect(result.meta.facets.content_type).toEqual(["code"]);
      expect(result.tree.length).toBeGreaterThan(0);
    } finally {
      await cleanupTempDir();
    }
  });

  test("indexes Go file into IndexedDocument", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "auth.go");
      await writeFile(filePath, GO_STRUCTS_AND_FUNCS);

      const result = await indexCodeFile(filePath, dir, "code");

      expect(result.meta.doc_id).toBe("code:auth");
      expect(result.meta.facets.language).toEqual(["go"]);
      expect(result.tree.length).toBeGreaterThan(0);
    } finally {
      await cleanupTempDir();
    }
  });

  test("generates content hash for incremental re-indexing", async () => {
    const dir = await setupTempDir();
    try {
      const file1 = join(dir, "a.ts");
      const file2 = join(dir, "b.ts");
      await writeFile(file1, TS_CLASS_WITH_METHODS);
      await writeFile(file2, TS_CLASS_WITH_METHODS);

      const r1 = await indexCodeFile(file1, dir, "code");
      const r2 = await indexCodeFile(file2, dir, "code");

      // Same content → same hash
      expect(r1.meta.content_hash).toBe(r2.meta.content_hash);
    } finally {
      await cleanupTempDir();
    }
  });

  test("tree nodes have correct parent-child relationships", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "auth.ts");
      await writeFile(filePath, TS_CLASS_WITH_METHODS);

      const result = await indexCodeFile(filePath, dir, "code");

      // Find the class node
      const classNode = result.tree.find((n) => n.title.includes("class AuthService"));
      expect(classNode).toBeDefined();

      // Its children should reference back to it
      for (const childId of classNode!.children) {
        const child = result.tree.find((n) => n.node_id === childId);
        expect(child).toBeDefined();
        expect(child!.parent_id).toBe(classNode!.node_id);
      }
    } finally {
      await cleanupTempDir();
    }
  });

  test("tree nodes have level hierarchy", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "auth.ts");
      await writeFile(filePath, TS_CLASS_WITH_METHODS);

      const result = await indexCodeFile(filePath, dir, "code");

      // Top-level symbols should be level 1
      const topLevel = result.tree.filter((n) => n.parent_id === null);
      for (const node of topLevel) {
        expect(node.level).toBe(1);
      }

      // Child symbols (methods) should be level 2
      const children = result.tree.filter((n) => n.parent_id !== null);
      for (const node of children) {
        expect(node.level).toBeGreaterThan(1);
      }
    } finally {
      await cleanupTempDir();
    }
  });

  test("handles nested directory paths", async () => {
    const dir = await setupTempDir();
    try {
      await mkdir(join(dir, "src", "auth"), { recursive: true });
      const filePath = join(dir, "src", "auth", "service.ts");
      await writeFile(filePath, TS_CLASS_WITH_METHODS);

      const result = await indexCodeFile(filePath, dir, "code");

      expect(result.meta.doc_id).toBe("code:src:auth:service");
      expect(result.meta.file_path).toBe("src/auth/service.ts");
    } finally {
      await cleanupTempDir();
    }
  });

  test("exported symbols appear in tags", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "auth.ts");
      await writeFile(filePath, TS_CLASS_WITH_METHODS);

      const result = await indexCodeFile(filePath, dir, "code");

      // Exported symbols like AuthService, validateToken should be in tags
      expect(result.meta.tags).toContain("AuthService");
      expect(result.meta.tags).toContain("validateToken");
    } finally {
      await cleanupTempDir();
    }
  });
});

// ── Integration: code in DocumentStore ──────────────────────────────

describe("code indexer + DocumentStore integration", () => {
  let store: DocumentStore;
  let tempDir: string;

  async function setupTempDir() {
    tempDir = await mkdtemp(join(tmpdir(), "doctree-store-code-"));
    return tempDir;
  }

  async function cleanupTempDir() {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  test("code files are searchable via BM25", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "auth.ts");
      await writeFile(filePath, TS_CLASS_WITH_METHODS);

      const doc = await indexCodeFile(filePath, dir, "code");
      store = new DocumentStore();
      store.load([doc]);

      const results = store.searchDocuments("authenticate");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].doc_id).toBe("code:auth");
    } finally {
      await cleanupTempDir();
    }
  });

  test("code files are filterable by language facet", async () => {
    const dir = await setupTempDir();
    try {
      const tsFile = join(dir, "auth.ts");
      const pyFile = join(dir, "db.py");
      await writeFile(tsFile, TS_CLASS_WITH_METHODS);
      await writeFile(pyFile, PY_CLASS_WITH_METHODS);

      const tsDocs = await indexCodeFile(tsFile, dir, "code");
      const pyDocs = await indexCodeFile(pyFile, dir, "code");

      store = new DocumentStore();
      store.load([tsDocs, pyDocs]);

      // Search with language filter
      const tsResults = store.searchDocuments("connection", {
        filters: { language: "typescript" },
      });
      for (const r of tsResults) {
        expect(r.facets.language).toContain("typescript");
      }

      const pyResults = store.searchDocuments("connection", {
        filters: { language: "python" },
      });
      for (const r of pyResults) {
        expect(r.facets.language).toContain("python");
      }
    } finally {
      await cleanupTempDir();
    }
  });

  test("code files are filterable by symbol_kind facet", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "auth.ts");
      await writeFile(filePath, TS_CLASS_WITH_METHODS);

      const doc = await indexCodeFile(filePath, dir, "code");
      store = new DocumentStore();
      store.load([doc]);

      // Search with content_type filter
      const results = store.searchDocuments("AuthService", {
        filters: { content_type: "code" },
      });
      expect(results.length).toBeGreaterThan(0);
    } finally {
      await cleanupTempDir();
    }
  });

  test("tree navigation works on code documents", async () => {
    const dir = await setupTempDir();
    try {
      const filePath = join(dir, "auth.ts");
      await writeFile(filePath, TS_CLASS_WITH_METHODS);

      const doc = await indexCodeFile(filePath, dir, "code");
      store = new DocumentStore();
      store.load([doc]);

      // get_tree equivalent
      const tree = store.getTree("code:auth");
      expect(tree).not.toBeNull();
      expect(tree!.nodes.length).toBeGreaterThan(0);

      // Verify tree has class and method nodes
      const classNode = tree!.nodes.find((n) => n.title.includes("class AuthService"));
      expect(classNode).toBeDefined();
      expect(classNode!.children.length).toBeGreaterThan(0);

      // get_node_content equivalent
      const content = store.getNodeContent("code:auth", [classNode!.node_id]);
      expect(content).not.toBeNull();
      expect(content!.nodes[0].content).toContain("AuthService");

      // get_subtree equivalent
      const subtree = store.getSubtree("code:auth", classNode!.node_id);
      expect(subtree).not.toBeNull();
      expect(subtree!.nodes.length).toBeGreaterThan(1); // class + methods
    } finally {
      await cleanupTempDir();
    }
  });

  test("mixed code + markdown search works", async () => {
    const dir = await setupTempDir();
    try {
      const tsFile = join(dir, "auth.ts");
      await writeFile(tsFile, TS_CLASS_WITH_METHODS);

      const codeDoc = await indexCodeFile(tsFile, dir, "code");

      // Also need a markdown doc for comparison — build manually
      const { indexFile } = await import("../src/indexer");
      const mdFile = join(dir, "auth-guide.md");
      await writeFile(
        mdFile,
        `---\ntitle: Auth Guide\ntags: [auth]\n---\n\n# Authentication\n\nHow to authenticate users.\n`
      );
      const mdDoc = await indexFile(mdFile, dir, "docs");

      store = new DocumentStore();
      store.load([codeDoc, mdDoc]);

      // Both should appear in search for "authentication"
      const results = store.searchDocuments("authentication");
      const docIds = results.map((r) => r.doc_id);
      expect(docIds).toContain("code:auth");
      expect(docIds).toContain("docs:auth-guide");
    } finally {
      await cleanupTempDir();
    }
  });
});
