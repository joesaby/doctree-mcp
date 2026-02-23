/**
 * Code Indexer — AST-based code navigation for doctree-mcp
 *
 * Maps source code files into the same IndexedDocument / TreeNode model
 * used by the markdown indexer. This lets the existing BM25 search,
 * facet filtering, tree navigation, and all 5 MCP tools work on code
 * files without any changes to the store or server.
 *
 * Design: Source file structure → TreeNode hierarchy
 *   - File         → document (IndexedDocument)
 *   - Class        → H1 node (level 1)
 *   - Method       → H2 node (level 2, child of class)
 *   - Function     → H1 node (level 1)
 *   - Interface    → H1 node (level 1)
 *   - Type alias   → H1 node (level 1)
 *   - Imports      → H1 node (level 1, grouped)
 *   - Properties   → H3 node (level 3, child of class/interface)
 *
 * The existing store.ts BM25 engine indexes these TreeNodes identically
 * to markdown nodes — title matches get title_weight boost, code content
 * gets code_weight boost, and facets like language/symbol_kind enable
 * filtering.
 */

import { stat } from "node:fs/promises";
import { relative, basename, extname } from "node:path";
import type {
  TreeNode,
  DocumentMeta,
  IndexedDocument,
  CollectionConfig,
} from "./types";
import { parseTypeScript, TYPESCRIPT_EXTENSIONS } from "./parsers/typescript";
import { parsePython, PYTHON_EXTENSIONS } from "./parsers/python";
import { parseGeneric, GENERIC_EXTENSIONS } from "./parsers/generic";

// ── Code symbol intermediate representation ──────────────────────────

/** Intermediate format produced by language parsers */
export interface CodeSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  signature: string;
  content: string;
  line_start: number;
  line_end: number;
  exported: boolean;
  children_ids: string[];
  parent_id: string | null;
}

export type SymbolKind =
  | "class"
  | "interface"
  | "function"
  | "method"
  | "property"
  | "type"
  | "enum"
  | "variable"
  | "import";

// ── Supported file extensions ────────────────────────────────────────

/** All file extensions the code indexer can handle */
export const CODE_EXTENSIONS = new Set([
  ...TYPESCRIPT_EXTENSIONS,
  ...PYTHON_EXTENSIONS,
  ...GENERIC_EXTENSIONS,
]);

/** Default glob pattern for code files */
export const CODE_GLOB = "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,pyi,go,rs,java,kt,scala,c,cpp,cc,h,hpp,cs,rb,swift,php,lua,sh,bash,zsh}";

/**
 * Check if a file extension is supported for code indexing.
 */
export function isCodeFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

// ── Language detection ───────────────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java", ".kt": "kotlin", ".scala": "scala",
  ".c": "c", ".cpp": "cpp", ".cc": "cpp", ".h": "c", ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".swift": "swift",
  ".php": "php",
  ".lua": "lua",
  ".r": "r", ".R": "r",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
};

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] || "unknown";
}

// ── Symbol → TreeNode mapping ────────────────────────────────────────

/**
 * Map a CodeSymbol hierarchy level for TreeNode.
 *
 * The hierarchy maps symbol kinds to heading levels:
 *   - Top-level containers (class, interface, enum) → level 1
 *   - Top-level functions/types/variables → level 1
 *   - Methods → level 2 (child of class/interface)
 *   - Properties → level 3 (child of class/interface)
 *   - Imports → level 1
 */
function symbolLevel(symbol: CodeSymbol): number {
  if (symbol.parent_id === null) return 1;
  switch (symbol.kind) {
    case "method": return 2;
    case "property": return 3;
    default: return 2;
  }
}

/**
 * Convert a CodeSymbol into a TreeNode.
 *
 * The title includes the kind prefix for searchability:
 *   "class AuthService" or "function authenticate"
 * The content is the full source code of the symbol.
 * The summary is the signature (function signature, class declaration).
 */
function symbolToTreeNode(symbol: CodeSymbol): TreeNode {
  const title = symbol.kind === "import"
    ? "imports"
    : `${symbol.kind} ${symbol.name}`;

  const content = symbol.content;
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  return {
    node_id: symbol.id,
    title,
    level: symbolLevel(symbol),
    parent_id: symbol.parent_id,
    children: symbol.children_ids,
    content,
    summary: symbol.signature.slice(0, 200),
    word_count: wordCount,
    line_start: symbol.line_start,
    line_end: symbol.line_end,
  };
}

// ── Parse source file ────────────────────────────────────────────────

/**
 * Parse a source file into CodeSymbols using the appropriate language parser.
 */
function parseSourceFile(source: string, docId: string, filePath: string): CodeSymbol[] {
  const ext = extname(filePath).toLowerCase();

  if (TYPESCRIPT_EXTENSIONS.has(ext)) {
    return parseTypeScript(source, docId);
  }
  if (PYTHON_EXTENSIONS.has(ext)) {
    return parsePython(source, docId);
  }
  if (GENERIC_EXTENSIONS.has(ext)) {
    return parseGeneric(source, docId, ext);
  }

  // Fallback: treat as generic
  return parseGeneric(source, docId, ext);
}

// ── Index a single code file ─────────────────────────────────────────

/**
 * Index a single source code file into an IndexedDocument.
 *
 * Produces the same structure as indexFile() in indexer.ts but for
 * code files. The resulting IndexedDocument is fully compatible with
 * the DocumentStore and all MCP tools.
 */
export async function indexCodeFile(
  filePath: string,
  docsRoot: string,
  collectionName: string = "code",
): Promise<IndexedDocument> {
  const raw = await Bun.file(filePath).text();
  const relPath = relative(docsRoot, filePath);
  const ext = extname(filePath).toLowerCase();
  const language = detectLanguage(filePath);

  // Build doc_id: collection:path segments (replacing / and . with :)
  const doc_id = `${collectionName}:${relPath.replace(/[/\\]/g, ":").replace(/\.\w+$/, "")}`;

  // Parse into symbols
  const symbols = parseSourceFile(raw, doc_id, filePath);

  // Convert to TreeNodes
  const tree: TreeNode[] = symbols.map(symbolToTreeNode);

  // If no symbols found, create a root node with the full file content
  if (tree.length === 0) {
    const lines = raw.split("\n");
    tree.push({
      node_id: `${doc_id}:n1`,
      title: basename(filePath),
      level: 1,
      parent_id: null,
      children: [],
      content: raw,
      summary: raw.slice(0, 200),
      word_count: raw.split(/\s+/).filter(Boolean).length,
      line_start: 1,
      line_end: lines.length,
    });
  }

  // Content hash for incremental re-indexing
  const content_hash = Bun.hash(raw).toString(16);

  // Collect unique symbol kinds for the symbol_kind facet
  const symbolKinds = [...new Set(symbols.map((s) => s.kind).filter((k) => k !== "import"))];

  // Detect exported symbols for faceting
  const exportedSymbols = symbols.filter((s) => s.exported && s.kind !== "import").map((s) => s.name);

  // Build facets
  const facets: Record<string, string[]> = {
    language: [language],
    content_type: ["code"],
  };
  if (symbolKinds.length > 0) {
    facets["symbol_kind"] = symbolKinds;
  }

  const root_nodes = tree.filter((n) => n.parent_id === null).map((n) => n.node_id);

  const title = basename(filePath);
  const description = buildCodeDescription(symbols, language);

  const fstat = await stat(filePath);

  const meta: DocumentMeta = {
    doc_id,
    file_path: relPath,
    title,
    description,
    word_count: tree.reduce((sum, n) => sum + n.word_count, 0),
    heading_count: tree.length,
    max_depth: Math.max(...tree.map((n) => n.level), 0),
    last_modified: fstat.mtime.toISOString(),
    tags: exportedSymbols.slice(0, 20), // Top exported symbols as tags for discovery
    content_hash,
    collection: collectionName,
    facets,
  };

  return { meta, tree, root_nodes };
}

// ── Scan directory for code files ────────────────────────────────────

/**
 * Index all code files in a collection.
 * Parallel to indexCollection() in indexer.ts.
 */
export async function indexCodeCollection(
  collection: CollectionConfig,
): Promise<IndexedDocument[]> {
  const { root, name, glob_pattern } = collection;
  const pattern = glob_pattern || CODE_GLOB;

  const glob = new Bun.Glob(pattern);
  const files: string[] = [];

  for await (const entry of glob.scan({ cwd: root, absolute: true })) {
    // Only include files the code indexer can handle
    if (isCodeFile(entry)) {
      files.push(entry);
    }
  }

  if (files.length === 0) return [];

  console.log(`[${name}] Found ${files.length} code files in ${root}`);

  const BATCH_SIZE = 50;
  const results: IndexedDocument[] = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const indexed = await Promise.all(
      batch.map((f) =>
        indexCodeFile(f, root, name).catch((err) => {
          console.warn(`Failed to index code file ${f}: ${err.message}`);
          return null;
        }),
      ),
    );
    results.push(...(indexed.filter(Boolean) as IndexedDocument[]));

    if (i + BATCH_SIZE < files.length) {
      console.log(`  [${name}] Indexed ${results.length}/${files.length} code files...`);
    }
  }

  console.log(`[${name}] Complete: ${results.length} code files indexed`);
  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a human-readable description from the extracted symbols.
 */
function buildCodeDescription(symbols: CodeSymbol[], language: string): string {
  const topLevel = symbols.filter((s) => s.parent_id === null && s.kind !== "import");
  if (topLevel.length === 0) return `${language} source file`;

  const parts: string[] = [];
  const classes = topLevel.filter((s) => s.kind === "class");
  const functions = topLevel.filter((s) => s.kind === "function");
  const interfaces = topLevel.filter((s) => s.kind === "interface");
  const types = topLevel.filter((s) => s.kind === "type");

  if (classes.length > 0) {
    parts.push(`${classes.length} class${classes.length > 1 ? "es" : ""}: ${classes.map((c) => c.name).join(", ")}`);
  }
  if (interfaces.length > 0) {
    parts.push(`${interfaces.length} interface${interfaces.length > 1 ? "s" : ""}: ${interfaces.map((i) => i.name).join(", ")}`);
  }
  if (functions.length > 0) {
    parts.push(`${functions.length} function${functions.length > 1 ? "s" : ""}: ${functions.map((f) => f.name).join(", ")}`);
  }
  if (types.length > 0) {
    parts.push(`${types.length} type${types.length > 1 ? "s" : ""}: ${types.map((t) => t.name).join(", ")}`);
  }

  const desc = parts.join("; ");
  return desc.length > 200 ? desc.slice(0, 197) + "..." : desc;
}
