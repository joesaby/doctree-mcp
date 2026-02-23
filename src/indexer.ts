/**
 * Markdown Tree Indexer
 *
 * Uses Bun.markdown.render() with custom callbacks to parse markdown files
 * into hierarchical section trees — the core of the PageIndex-style approach.
 *
 * New in this version (Pagefind-inspired additions):
 *   - Content hashing for incremental re-indexing (Pagefind fragment hashing)
 *   - Facet extraction from frontmatter (Pagefind data-pagefind-filter)
 *   - Collection support for multi-root indexing (Pagefind multisite)
 *   - max_depth tracking per document
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative, basename, extname } from "node:path";
import type {
  TreeNode,
  DocumentMeta,
  IndexedDocument,
  IndexConfig,
  CollectionConfig,
} from "./types";
import { indexCodeCollection, isCodeFile } from "./code-indexer";

// ── State machine for tracking parse position ────────────────────────

interface ParseState {
  nodes: TreeNode[];
  node_stack: string[];
  current_node_id: string | null;
  content_buffer: string[];
  node_counter: number;
  doc_id: string;
}

function createParseState(doc_id: string): ParseState {
  return {
    nodes: [],
    node_stack: [],
    current_node_id: null,
    content_buffer: [],
    node_counter: 0,
    doc_id,
  };
}

function makeNodeId(doc_id: string, counter: number): string {
  return `${doc_id}:n${counter}`;
}

function flushContent(state: ParseState): void {
  if (state.current_node_id && state.content_buffer.length > 0) {
    const node = state.nodes.find((n) => n.node_id === state.current_node_id);
    if (node) {
      const text = state.content_buffer.join("\n").trim();
      node.content = text;
      node.word_count = text.split(/\s+/).filter(Boolean).length;
      node.summary = text.slice(0, 200) + (text.length > 200 ? "…" : "");
    }
  }
  state.content_buffer = [];
}

function findParentId(state: ParseState, level: number): string | null {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    if (state.nodes[i].level < level) {
      return state.nodes[i].node_id;
    }
  }
  return null;
}

// ── Check if Bun.markdown is available (requires Bun 1.3.8+) ─────────

const hasBunMarkdown = typeof Bun !== "undefined" &&
  typeof (Bun as any).markdown?.render === "function";

if (!hasBunMarkdown) {
  console.log("[doctree] Using regex parser (Bun.markdown requires Bun 1.3.8+)");
}

// ── Core: Build tree from markdown ───────────────────────────────────

export function buildTree(markdown: string, doc_id: string): TreeNode[] {
  if (!hasBunMarkdown) {
    return buildTreeRegex(markdown, doc_id);
  }

  const state = createParseState(doc_id);
  const lines = markdown.split("\n");

  try {
    (Bun as any).markdown.render(markdown, {
      heading: (children: string, { level }: { level: number }) => {
        flushContent(state);
        state.node_counter++;
        const node_id = makeNodeId(doc_id, state.node_counter);
        const parent_id = findParentId(state, level);

        const node: TreeNode = {
          node_id,
          title: stripHtml(children),
          level,
          parent_id,
          children: [],
          content: "",
          summary: "",
          word_count: 0,
          line_start: findHeadingLine(lines, stripHtml(children), 0),
          line_end: -1,
        };

        if (parent_id) {
          const parent = state.nodes.find((n) => n.node_id === parent_id);
          if (parent) parent.children.push(node_id);
        }

        if (state.current_node_id) {
          const prev = state.nodes.find(
            (n) => n.node_id === state.current_node_id
          );
          if (prev) prev.line_end = node.line_start - 1;
        }

        state.nodes.push(node);
        state.current_node_id = node_id;
        return `<h${level}>${children}</h${level}>`;
      },

      paragraph: (children: string) => {
        state.content_buffer.push(stripHtml(children));
        return `<p>${children}</p>`;
      },

      code_block: (code: string, { language }: { language?: string }) => {
        const lang = language || "";
        state.content_buffer.push(`[code:${lang}] ${code}`);
        return `<pre><code>${code}</code></pre>`;
      },

      list: (children: string, { ordered }: { ordered: boolean }) => {
        state.content_buffer.push(stripHtml(children));
        return ordered ? `<ol>${children}</ol>` : `<ul>${children}</ul>`;
      },

      blockquote: (children: string) => {
        state.content_buffer.push(`> ${stripHtml(children)}`);
        return `<blockquote>${children}</blockquote>`;
      },

      table: (children: string) => {
        state.content_buffer.push(`[table] ${stripHtml(children)}`);
        return `<table>${children}</table>`;
      },
    });
  } catch (e) {
    return buildTreeRegex(markdown, doc_id);
  }

  flushContent(state);

  if (state.current_node_id) {
    const last = state.nodes.find(
      (n) => n.node_id === state.current_node_id
    );
    if (last) last.line_end = lines.length;
  }

  if (state.nodes.length === 0) {
    const rootNode: TreeNode = {
      node_id: makeNodeId(doc_id, 1),
      title: "(document root)",
      level: 0,
      parent_id: null,
      children: [],
      content: markdown.trim(),
      summary: markdown.trim().slice(0, 200),
      word_count: markdown.split(/\s+/).filter(Boolean).length,
      line_start: 1,
      line_end: lines.length,
    };
    return [rootNode];
  }

  return state.nodes;
}

// ── Regex-based markdown parser ──────────────────────────────────────

function buildTreeRegex(markdown: string, doc_id: string): TreeNode[] {
  const lines = markdown.split("\n");
  const nodes: TreeNode[] = [];
  let counter = 0;
  let contentBuffer: string[] = [];
  let currentNodeId: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      if (currentNodeId) {
        const prev = nodes.find((n) => n.node_id === currentNodeId);
        if (prev) {
          const text = contentBuffer.join("\n").trim();
          prev.content = text;
          prev.word_count = text.split(/\s+/).filter(Boolean).length;
          prev.summary = text.slice(0, 200);
          prev.line_end = i;
        }
      }
      contentBuffer = [];

      counter++;
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      const node_id = makeNodeId(doc_id, counter);

      let parent_id: string | null = null;
      for (let j = nodes.length - 1; j >= 0; j--) {
        if (nodes[j].level < level) {
          parent_id = nodes[j].node_id;
          nodes[j].children.push(node_id);
          break;
        }
      }

      nodes.push({
        node_id,
        title,
        level,
        parent_id,
        children: [],
        content: "",
        summary: "",
        word_count: 0,
        line_start: i + 1,
        line_end: -1,
      });

      currentNodeId = node_id;
    } else {
      contentBuffer.push(lines[i]);
    }
  }

  if (currentNodeId) {
    const last = nodes.find((n) => n.node_id === currentNodeId);
    if (last) {
      const text = contentBuffer.join("\n").trim();
      last.content = text;
      last.word_count = text.split(/\s+/).filter(Boolean).length;
      last.summary = text.slice(0, 200);
      last.line_end = lines.length;
    }
  }

  return nodes;
}

// ── Frontmatter extraction ──────────────────────────────────────────

interface Frontmatter {
  title?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

function extractFrontmatter(markdown: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return { frontmatter: {}, body: markdown };

  const fm: Frontmatter = {};
  const fmLines = fmMatch[1].split("\n");
  for (const line of fmLines) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) {
      const [, key, value] = kv;
      if (value.startsWith("[")) {
        fm[key] = value
          .replace(/[\[\]]/g, "")
          .split(",")
          .map((s) => s.trim().replace(/['"]/g, ""));
      } else {
        fm[key] = value.replace(/^['"]|['"]$/g, "");
      }
    }
  }

  return { frontmatter: fm, body: fmMatch[2] };
}

// ── Extract facets from frontmatter (Pagefind data-pagefind-filter) ──
//
// Pagefind uses data-pagefind-filter="key:value" attributes on HTML elements
// to build faceted search. We extract the equivalent from frontmatter:
// any key-value pair that isn't title/description becomes a filter facet.

const RESERVED_FRONTMATTER_KEYS = new Set([
  "title",
  "description",
  "layout",
  "permalink",
  "slug",
  "draft",
  "date",
]);

function extractFacets(frontmatter: Frontmatter): Record<string, string[]> {
  const facets: Record<string, string[]> = {};

  for (const [key, value] of Object.entries(frontmatter)) {
    if (RESERVED_FRONTMATTER_KEYS.has(key)) continue;
    if (key === "tags") continue; // handled separately in DocumentMeta
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      facets[key] = value.map(String);
    } else if (typeof value === "string" || typeof value === "number") {
      facets[key] = [String(value)];
    }
  }

  return facets;
}

// ── Path-based type inference ───────────────────────────────────────
//
// When frontmatter lacks a "type" field, infer document type from the
// directory structure. Maps common directory naming conventions to
// document types that become filterable facets.

const PATH_TYPE_PATTERNS: [RegExp, string][] = [
  [/\brunbooks?\b/i, "runbook"],
  [/\bguides?\b/i, "guide"],
  [/\btutorials?\b/i, "tutorial"],
  [/\breference\b/i, "reference"],
  [/\bapi[-_]?docs?\b/i, "api-reference"],
  [/\barchitectur(e|al)\b/i, "architecture"],
  [/\badr[s]?\b/i, "adr"],
  [/\brfc[s]?\b/i, "rfc"],
  [/\bprocedures?\b/i, "procedure"],
  [/\bplaybooks?\b/i, "playbook"],
  [/\btroubleshoot/i, "troubleshooting"],
  [/\bfaq[s]?\b/i, "faq"],
  [/\bchangelog/i, "changelog"],
  [/\brelease[-_]?notes?\b/i, "release-notes"],
  [/\bhowto\b/i, "howto"],
  [/\bops\b/i, "operations"],
  [/\bdeploy/i, "deployment"],
  [/\bpipeline/i, "pipeline"],
  [/\bonboard/i, "onboarding"],
  [/\bpostmortem/i, "postmortem"],
];

function inferTypeFromPath(relPath: string): string | null {
  // Check directory segments (not filename) for type patterns
  const dirPath = relPath.includes("/")
    ? relPath.substring(0, relPath.lastIndexOf("/"))
    : "";

  for (const [pattern, type] of PATH_TYPE_PATTERNS) {
    if (pattern.test(dirPath)) {
      return type;
    }
  }

  return null;
}

// ── Generic title improvement ───────────────────────────────────────
//
// Many docs use generic titles like "Introduction" or "Overview" that
// hurt search ranking. Prefix with the parent directory name for context.

const GENERIC_TITLES = new Set([
  "introduction",
  "index",
  "overview",
  "readme",
  "getting started",
  "home",
  "main",
  "about",
  "summary",
]);

function improveGenericTitle(title: string, relPath: string): string {
  if (!GENERIC_TITLES.has(title.toLowerCase())) return title;

  // Extract parent directory name as context
  const parts = relPath.replace(/\.md$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return title;

  // Use the immediate parent directory
  const parent = parts[parts.length - 2]
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return `${parent} — ${title}`;
}

// ── Content hashing (Pagefind-inspired) ─────────────────────────────
//
// Pagefind generates content-based fragment hashes so unchanged pages
// produce identical filenames across builds. We use content hashing
// for incremental re-indexing: skip files whose hash hasn't changed.

function computeContentHash(content: string): string {
  // Bun.hash returns a bigint; convert to hex string
  return Bun.hash(content).toString(16);
}

// ── Index a single markdown file ────────────────────────────────────

export async function indexFile(
  filePath: string,
  docsRoot: string,
  collectionName: string = "docs"
): Promise<IndexedDocument> {
  const raw = await Bun.file(filePath).text();
  const relPath = relative(docsRoot, filePath);
  const doc_id = `${collectionName}:${relPath.replace(/\.md$/i, "").replace(/[/\\]/g, ":")}`;

  const { frontmatter, body } = extractFrontmatter(raw);
  const tree = buildTree(body, doc_id);

  // Content hash for incremental re-indexing (Pagefind-inspired)
  const content_hash = computeContentHash(raw);

  // Extract facets from frontmatter (Pagefind data-pagefind-filter)
  const facets = extractFacets(frontmatter);

  let title =
    (frontmatter.title as string) ||
    tree.find((n) => n.level <= 1)?.title ||
    basename(filePath, extname(filePath));

  // Improve generic titles like "Introduction" with parent directory context
  title = improveGenericTitle(title, relPath);

  const description =
    (frontmatter.description as string) || tree[0]?.summary || "";

  const root_nodes = tree
    .filter((n) => n.parent_id === null)
    .map((n) => n.node_id);

  // max_depth: deepest heading level in the document
  const max_depth = tree.reduce((max, n) => Math.max(max, n.level), 0);

  // Auto-infer document type from path when not in frontmatter
  if (!facets["type"]) {
    const inferredType = inferTypeFromPath(relPath);
    if (inferredType) {
      facets["type"] = [inferredType];
    }
  }

  const fstat = await stat(filePath);

  const meta: DocumentMeta = {
    doc_id,
    file_path: relPath,
    title,
    description,
    word_count: tree.reduce((sum, n) => sum + n.word_count, 0),
    heading_count: tree.length,
    max_depth,
    last_modified: fstat.mtime.toISOString(),
    tags: (frontmatter.tags as string[]) || [],
    content_hash,
    collection: collectionName,
    facets,
  };

  return { meta, tree, root_nodes };
}

// ── Scan directory and index all markdown files ─────────────────────

export async function indexCollection(
  collection: CollectionConfig
): Promise<IndexedDocument[]> {
  const { root, name, glob_pattern } = collection;
  const pattern = glob_pattern || "**/*.md";

  const glob = new Bun.Glob(pattern);
  const files: string[] = [];

  for await (const entry of glob.scan({ cwd: root, absolute: true })) {
    files.push(entry);
  }

  console.log(`[${name}] Found ${files.length} markdown files in ${root}`);

  const BATCH_SIZE = 50;
  const results: IndexedDocument[] = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const indexed = await Promise.all(
      batch.map((f) =>
        indexFile(f, root, name).catch((err) => {
          console.warn(`Failed to index ${f}: ${err.message}`);
          return null;
        })
      )
    );
    results.push(...(indexed.filter(Boolean) as IndexedDocument[]));

    if (i + BATCH_SIZE < files.length) {
      console.log(`  [${name}] Indexed ${results.length}/${files.length}...`);
    }
  }

  console.log(`[${name}] Complete: ${results.length} documents indexed`);
  return results;
}

/**
 * Index all collections defined in config.
 * Supports Pagefind-style multisite: multiple roots, each a named collection.
 * Also indexes code collections if configured.
 */
export async function indexAllCollections(
  config: IndexConfig
): Promise<IndexedDocument[]> {
  const allDocs: IndexedDocument[] = [];

  // Index markdown collections
  for (const collection of config.collections) {
    const docs = await indexCollection(collection);
    allDocs.push(...docs);
  }

  // Index code collections (AST-based)
  if (config.code_collections && config.code_collections.length > 0) {
    for (const collection of config.code_collections) {
      const codeDocs = await indexCodeCollection(collection);
      allDocs.push(...codeDocs);
    }
  }

  const mdCount = config.collections.length;
  const codeCount = config.code_collections?.length || 0;
  console.log(`Total: ${allDocs.length} documents across ${mdCount} doc + ${codeCount} code collection(s)`);
  return allDocs;
}

/**
 * Backwards-compatible wrapper for indexing a single directory.
 * @deprecated Use indexAllCollections with singleRootConfig instead.
 */
export async function indexDirectory(config: {
  docs_root: string;
  glob_pattern?: string;
  max_depth?: number;
  summary_length?: number;
}): Promise<IndexedDocument[]> {
  const collection: CollectionConfig = {
    name: "docs",
    root: config.docs_root,
    weight: 1.0,
    glob_pattern: config.glob_pattern || "**/*.md",
  };
  return indexCollection(collection);
}

// ── Helpers ──────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

function findHeadingLine(
  lines: string[],
  title: string,
  startFrom: number
): number {
  for (let i = startFrom; i < lines.length; i++) {
    if (lines[i].includes(title)) return i + 1;
  }
  return startFrom + 1;
}
