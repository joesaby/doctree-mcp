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

function extractFirstSentence(text: string, maxLen: number): string {
  if (!text || text.length === 0) return "";

  // Skip leading code blocks, tables, and list markers
  const cleaned = text
    .replace(/^\[code:\w*\].*$/m, "")
    .replace(/^\s*[-*•]\s*/m, "")
    .trim();
  if (!cleaned)
    return text.slice(0, maxLen) + (text.length > maxLen ? "…" : "");

  // First sentence boundary: period/question/exclamation followed by
  // whitespace or end-of-string, but not inside abbreviations
  const sentenceEnd = cleaned.search(/[.!?](?:\s|$)/);

  if (sentenceEnd !== -1 && sentenceEnd < maxLen) {
    return cleaned.slice(0, sentenceEnd + 1);
  }

  // No sentence boundary — fall back to word-boundary slice
  if (cleaned.length <= maxLen) return cleaned;
  const truncated = cleaned.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.6) {
    return truncated.slice(0, lastSpace) + "…";
  }
  return truncated + "…";
}

function flushContent(state: ParseState): void {
  if (state.current_node_id && state.content_buffer.length > 0) {
    const node = state.nodes.find((n) => n.node_id === state.current_node_id);
    if (node) {
      const text = state.content_buffer.join("\n").trim();
      node.content = text;
      node.word_count = text.split(/\s+/).filter(Boolean).length;
      node.summary = extractFirstSentence(text, 200);
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
          prev.summary = extractFirstSentence(text, 200);
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
      last.summary = extractFirstSentence(text, 200);
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

export function inferTypeFromPath(relPath: string): string | null {
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

// ── Cross-reference extraction ──────────────────────────────────────

function extractReferences(body: string, relPath: string): string[] {
  const refs = new Set<string>();
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(body)) !== null) {
    const target = match[2].split("#")[0].trim();
    if (!target) continue;
    if (/^https?:\/\//i.test(target)) continue;
    if (/^mailto:/i.test(target)) continue;
    if (target.startsWith("/")) {
      refs.add(target.replace(/^\//, ""));
    } else {
      const dir = relPath.includes("/")
        ? relPath.substring(0, relPath.lastIndexOf("/"))
        : "";
      const resolved = dir ? `${dir}/${target}` : target;
      refs.add(normalizePath(resolved));
    }
  }
  return [...refs];
}

function normalizePath(path: string): string {
  const parts = path.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === ".." && normalized.length > 0) {
      normalized.pop();
    } else if (part !== "..") {
      normalized.push(part);
    }
  }
  return normalized.join("/");
}

// ── Content facet auto-detection ────────────────────────────────────

function extractContentFacets(body: string): Record<string, string[]> {
  const facets: Record<string, string[]> = {};

  const codeBlockRegex = /```(\w+)?/g;
  const languages = new Set<string>();
  let hasCode = false;
  let codeMatch;
  while ((codeMatch = codeBlockRegex.exec(body)) !== null) {
    hasCode = true;
    if (codeMatch[1]) languages.add(codeMatch[1].toLowerCase());
  }

  if (hasCode) facets["has_code"] = ["true"];
  if (languages.size > 0) facets["code_languages"] = [...languages].sort();

  const linkCount = (body.match(/\[[^\]]*\]\([^)]+\)/g) || []).filter(
    (m) => !/\]\(https?:\/\//i.test(m)
  ).length;
  if (linkCount > 0) facets["has_links"] = ["true"];

  return facets;
}

// ── Auto-glossary extraction ────────────────────────────────────────

export function extractGlossaryEntries(
  text: string
): Record<string, string[]> {
  const entries: Record<string, string[]> = {};

  // Pattern 1: ACRONYM (Expansion)
  const acronymFirst =
    /\b([A-Z][A-Z0-9]{1,10})\s+\(([A-Z][a-zA-Z\s]{3,60})\)/g;
  let m;
  while ((m = acronymFirst.exec(text)) !== null) {
    const acronym = m[1];
    const expansion = m[2].trim().toLowerCase();
    if (!entries[acronym]) entries[acronym] = [];
    if (!entries[acronym].includes(expansion)) entries[acronym].push(expansion);
  }

  // Pattern 2: Expansion (ACRONYM)
  const expansionFirst =
    /([A-Z][a-zA-Z\s]{3,60})\s+\(([A-Z][A-Z0-9]{1,10})\)/g;
  while ((m = expansionFirst.exec(text)) !== null) {
    const expansion = m[1].trim().toLowerCase();
    const acronym = m[2];
    if (!entries[acronym]) entries[acronym] = [];
    if (!entries[acronym].includes(expansion)) entries[acronym].push(expansion);
  }

  // Pattern 3: ACRONYM — Expansion (em dash)
  const dashPattern =
    /\b([A-Z][A-Z0-9]{1,10})\s*[—–-]\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)(?:\s|[.,;]|$)/g;
  while ((m = dashPattern.exec(text)) !== null) {
    const acronym = m[1];
    const expansion = m[2].trim().toLowerCase();
    if (!entries[acronym]) entries[acronym] = [];
    if (!entries[acronym].includes(expansion)) entries[acronym].push(expansion);
  }

  return entries;
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

  // Extract content-based facets (code languages, link presence)
  const contentFacets = extractContentFacets(body);
  for (const [key, values] of Object.entries(contentFacets)) {
    if (!facets[key]) facets[key] = values;
  }

  // Extract cross-references from markdown links
  const references = extractReferences(body, relPath);

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
    references,
  };

  return { meta, tree, root_nodes };
}

// ── Scan directory and index all markdown files ─────────────────────

export async function indexCollection(
  collection: CollectionConfig
): Promise<IndexedDocument[]> {
  const { root, name, glob_pattern, glob_patterns } = collection;
  const patterns = glob_patterns || [glob_pattern || "**/*.md"];

  const files: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    for await (const entry of glob.scan({ cwd: root, absolute: true })) {
      if (!seen.has(entry)) {
        seen.add(entry);
        files.push(entry);
      }
    }
  }

  const mdCount = files.filter(f => f.endsWith(".md")).length;
  const csvCount = files.filter(f => f.endsWith(".csv")).length;
  const jsonlCount = files.filter(f => f.endsWith(".jsonl")).length;
  const parts = [`${mdCount} md`];
  if (csvCount > 0) parts.push(`${csvCount} csv`);
  if (jsonlCount > 0) parts.push(`${jsonlCount} jsonl`);
  console.log(`[${name}] Found ${files.length} files (${parts.join(", ")}) in ${root}`);

  const BATCH_SIZE = 50;
  const results: IndexedDocument[] = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const indexed = await Promise.all(
      batch.map((f) => {
        const ext = extname(f).toLowerCase();
        let indexFn: (f: string, r: string, c: string) => Promise<IndexedDocument>;
        if (ext === ".csv") indexFn = indexCsvFile;
        else if (ext === ".jsonl") indexFn = indexJsonlFile;
        else indexFn = indexFile;
        return indexFn(f, root, name).catch((err) => {
          console.warn(`Failed to index ${f}: ${err.message}`);
          return null;
        });
      })
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
 */
export async function indexAllCollections(
  config: IndexConfig
): Promise<IndexedDocument[]> {
  const allDocs: IndexedDocument[] = [];

  for (const collection of config.collections) {
    const docs = await indexCollection(collection);
    allDocs.push(...docs);
  }

  console.log(`Total: ${allDocs.length} documents across ${config.collections.length} collection(s)`);
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

// ── CSV parser (state machine — no external deps) ──────────────────

interface CsvColumnRoles {
  id: number;
  title: number;
  text: number[];
  facets: number[];
  url: number;
  relation: number[];
}

function detectCsvColumnRoles(headers: string[]): CsvColumnRoles {
  const roles: CsvColumnRoles = { id: 0, title: -1, text: [], facets: [], url: -1, relation: [] };

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim().toLowerCase();

    if (roles.id === 0 && /^(issue.?key|key|id)$/i.test(h)) roles.id = i;
    else if (roles.title === -1 && /^(summary|title|name)$/i.test(h)) roles.title = i;
    else if (/^(description|quick.?notes|business.?justification|objective)$/i.test(h)) roles.text.push(i);
    else if (/^(status|team|theme|architect|target.?quarter|t-shirt|dor(?!\s*link))$/i.test(h)) roles.facets.push(i);
    else if (roles.url === -1 && /^(url|link|href)$/i.test(h)) roles.url = i;
    else if (/^(issue.?links?|child.?issues?|dor.?link)$/i.test(h)) roles.relation.push(i);
  }

  if (roles.title === -1) roles.title = roles.id;
  // summary column is both title and text
  const summaryIdx = headers.findIndex(h => /^summary$/i.test(h.trim()));
  if (summaryIdx !== -1 && !roles.text.includes(summaryIdx)) roles.text.push(summaryIdx);

  return roles;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function parseCsvMultiline(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.split("\n");
  let currentLine = "";
  let inQuotes = false;

  for (const line of lines) {
    if (!inQuotes) {
      currentLine = line;
    } else {
      currentLine += "\n" + line;
    }

    let quoteCount = 0;
    for (const ch of currentLine) {
      if (ch === '"') quoteCount++;
    }
    inQuotes = quoteCount % 2 !== 0;

    if (!inQuotes) {
      rows.push(parseCsvLine(currentLine));
      currentLine = "";
    }
  }

  if (currentLine) {
    rows.push(parseCsvLine(currentLine));
  }

  return rows;
}

const CSV_MAX_TEXT_LENGTH = parseInt(process.env.CSV_MAX_TEXT_LENGTH || "2000");

export async function indexCsvFile(
  filePath: string,
  docsRoot: string,
  collectionName: string = "docs"
): Promise<IndexedDocument> {
  const raw = await Bun.file(filePath).text();
  const relPath = relative(docsRoot, filePath);
  const doc_id = `${collectionName}:${relPath.replace(/\.(csv|jsonl)$/i, "").replace(/[/\\]/g, ":")}`;

  const rows = parseCsvMultiline(raw);
  if (rows.length < 2) {
    return emptyDocument(doc_id, relPath, collectionName, filePath, raw);
  }

  const headers = rows[0].map(h => h.trim());
  const roles = detectCsvColumnRoles(headers);

  const tree: TreeNode[] = [];
  let nodeCounter = 0;

  // Synthetic root node
  nodeCounter++;
  const rootId = makeNodeId(doc_id, nodeCounter);
  const rootNode: TreeNode = {
    node_id: rootId,
    title: basename(filePath, extname(filePath)),
    level: 1,
    parent_id: null,
    children: [],
    content: `${rows.length - 1} rows, ${headers.length} columns: ${headers.join(", ")}`,
    summary: `${rows.length - 1} rows from ${basename(filePath)}`,
    word_count: 0,
    line_start: 1,
    line_end: 1,
  };
  tree.push(rootNode);

  const allFacets: Record<string, Set<string>> = {};

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < 2 || row.every(c => !c.trim())) continue;

    nodeCounter++;
    const nodeId = makeNodeId(doc_id, nodeCounter);
    rootNode.children.push(nodeId);

    const keyVal = (row[roles.id] || "").trim();
    const titleVal = (row[roles.title] || keyVal || `Row ${r}`).trim();
    const nodeTitle = keyVal && keyVal !== titleVal ? `${keyVal} — ${titleVal}` : titleVal;

    // Build content
    const contentParts: string[] = [];
    if (keyVal) contentParts.push(`Issue Key: ${keyVal}`);

    // Facet values inline
    const facetLine: string[] = [];
    for (const fi of roles.facets) {
      const val = (row[fi] || "").trim();
      if (val) {
        facetLine.push(`${headers[fi]}: ${val}`);
        const key = headers[fi].toLowerCase().replace(/[^a-z0-9]+/g, "_");
        if (!allFacets[key]) allFacets[key] = new Set();
        allFacets[key].add(val);
      }
    }
    if (facetLine.length) contentParts.push(facetLine.join(" | "));

    if (roles.url !== -1) {
      const urlVal = (row[roles.url] || "").trim();
      if (urlVal) contentParts.push(`URL: ${urlVal}`);
    }

    contentParts.push("");

    // Text fields (truncated for indexing)
    for (const ti of roles.text) {
      const text = (row[ti] || "").trim();
      if (text) {
        const truncated = text.length > CSV_MAX_TEXT_LENGTH ? text.slice(0, CSV_MAX_TEXT_LENGTH) + "…" : text;
        contentParts.push(truncated);
      }
    }

    // Relations
    for (const ri of roles.relation) {
      const relText = (row[ri] || "").trim();
      if (relText) contentParts.push(`${headers[ri]}: ${relText}`);
    }

    const content = contentParts.join("\n").trim();

    tree.push({
      node_id: nodeId,
      title: nodeTitle,
      level: 2,
      parent_id: rootId,
      children: [],
      content,
      summary: extractFirstSentence(content, 200),
      word_count: content.split(/\s+/).filter(Boolean).length,
      line_start: r + 1,
      line_end: r + 1,
    });
  }

  rootNode.word_count = tree.reduce((s, n) => s + n.word_count, 0);

  const facets: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(allFacets)) {
    facets[k] = [...v];
  }
  facets["format"] = ["csv"];

  const fstat = await stat(filePath);
  const meta: DocumentMeta = {
    doc_id,
    file_path: relPath,
    title: basename(filePath, extname(filePath)),
    description: `${rows.length - 1} rows, ${headers.length} columns`,
    word_count: rootNode.word_count,
    heading_count: tree.length,
    max_depth: 2,
    last_modified: fstat.mtime.toISOString(),
    tags: [],
    content_hash: computeContentHash(raw),
    collection: collectionName,
    facets,
    references: [],
  };

  return { meta, tree, root_nodes: [rootId] };
}

// ── JSONL parser ────────────────────────────────────────────────────

interface JsonlFieldRoles {
  key: string | null;
  title: string | null;
  text: string[];
  relation: string[];
  facets: string[];
}

function detectJsonlFieldRoles(obj: Record<string, unknown>): JsonlFieldRoles {
  const keys = Object.keys(obj);
  const roles: JsonlFieldRoles = { key: null, title: null, text: [], relation: [], facets: [] };

  for (const k of keys) {
    const kl = k.toLowerCase();
    if (!roles.key && /^(key|id|issue_key)$/.test(kl)) roles.key = k;
    else if (!roles.title && /^(summary|title|description|name)$/.test(kl)) roles.title = k;
    else if (/^(paths?|pages?)$/.test(kl)) roles.relation.push(k);
    else if (/^(status|team|corpus|type|category)$/.test(kl)) roles.facets.push(k);
    else roles.text.push(k);
  }

  return roles;
}

export async function indexJsonlFile(
  filePath: string,
  docsRoot: string,
  collectionName: string = "docs"
): Promise<IndexedDocument> {
  const raw = await Bun.file(filePath).text();
  const relPath = relative(docsRoot, filePath);
  const doc_id = `${collectionName}:${relPath.replace(/\.(csv|jsonl)$/i, "").replace(/[/\\]/g, ":")}`;

  const lines = raw.split("\n").filter(l => l.trim());
  if (lines.length === 0) {
    return emptyDocument(doc_id, relPath, collectionName, filePath, raw);
  }

  // Detect roles from first line
  let firstObj: Record<string, unknown>;
  try {
    firstObj = JSON.parse(lines[0]);
  } catch {
    return emptyDocument(doc_id, relPath, collectionName, filePath, raw);
  }
  const roles = detectJsonlFieldRoles(firstObj);

  const tree: TreeNode[] = [];
  let nodeCounter = 0;

  // Synthetic root
  nodeCounter++;
  const rootId = makeNodeId(doc_id, nodeCounter);
  const rootNode: TreeNode = {
    node_id: rootId,
    title: basename(filePath, extname(filePath)),
    level: 1,
    parent_id: null,
    children: [],
    content: `${lines.length} records`,
    summary: `${lines.length} records from ${basename(filePath)}`,
    word_count: 0,
    line_start: 1,
    line_end: 1,
  };
  tree.push(rootNode);

  const allFacets: Record<string, Set<string>> = {};

  for (let i = 0; i < lines.length; i++) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    nodeCounter++;
    const nodeId = makeNodeId(doc_id, nodeCounter);
    rootNode.children.push(nodeId);

    const keyVal = roles.key ? String(obj[roles.key] || "") : `row-${i + 1}`;
    const titleVal = roles.title ? String(obj[roles.title] || keyVal) : keyVal;
    const nodeTitle = keyVal && keyVal !== titleVal ? `${keyVal} — ${titleVal}` : keyVal;

    const contentParts: string[] = [];
    if (keyVal) contentParts.push(keyVal);

    // Facets
    const facetLine: string[] = [];
    for (const fk of roles.facets) {
      const val = obj[fk];
      if (val !== undefined && val !== null && val !== "") {
        const strVal = String(val);
        facetLine.push(`${fk}: ${strVal}`);
        const normKey = fk.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        if (!allFacets[normKey]) allFacets[normKey] = new Set();
        allFacets[normKey].add(strVal);
      }
    }
    if (facetLine.length) contentParts.push(facetLine.join(" | "));

    // Title/text
    if (roles.title && obj[roles.title]) {
      contentParts.push(String(obj[roles.title]));
    }
    for (const tk of roles.text) {
      const val = obj[tk];
      if (val !== undefined && val !== null && val !== "") {
        if (typeof val === "number") {
          contentParts.push(`${tk}: ${val}`);
        } else {
          contentParts.push(String(val));
        }
      }
    }

    // Relations (arrays of paths/pages)
    for (const rk of roles.relation) {
      const val = obj[rk];
      if (Array.isArray(val) && val.length > 0) {
        const items = val.map(v => typeof v === "string" ? v : (v as any).path || (v as any).title || JSON.stringify(v));
        contentParts.push(`Related docs: ${items.join(", ")}`);
      }
    }

    const content = contentParts.join("\n").trim();

    tree.push({
      node_id: nodeId,
      title: nodeTitle,
      level: 2,
      parent_id: rootId,
      children: [],
      content,
      summary: extractFirstSentence(content, 200),
      word_count: content.split(/\s+/).filter(Boolean).length,
      line_start: i + 1,
      line_end: i + 1,
    });
  }

  rootNode.word_count = tree.reduce((s, n) => s + n.word_count, 0);

  const facets: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(allFacets)) {
    facets[k] = [...v];
  }
  facets["format"] = ["jsonl"];

  const fstat = await stat(filePath);
  const meta: DocumentMeta = {
    doc_id,
    file_path: relPath,
    title: basename(filePath, extname(filePath)),
    description: `${lines.length} records`,
    word_count: rootNode.word_count,
    heading_count: tree.length,
    max_depth: 2,
    last_modified: fstat.mtime.toISOString(),
    tags: [],
    content_hash: computeContentHash(raw),
    collection: collectionName,
    facets,
    references: [],
  };

  return { meta, tree, root_nodes: [rootId] };
}

// ── Empty document fallback ────────────────────────────────────────

async function emptyDocument(
  doc_id: string,
  relPath: string,
  collectionName: string,
  filePath: string,
  raw: string
): Promise<IndexedDocument> {
  const fstat = await stat(filePath);
  const rootId = makeNodeId(doc_id, 1);
  return {
    meta: {
      doc_id,
      file_path: relPath,
      title: basename(filePath, extname(filePath)),
      description: "Empty or unparseable file",
      word_count: 0,
      heading_count: 1,
      max_depth: 1,
      last_modified: fstat.mtime.toISOString(),
      tags: [],
      content_hash: computeContentHash(raw),
      collection: collectionName,
      facets: {},
      references: [],
    },
    tree: [{
      node_id: rootId,
      title: basename(filePath, extname(filePath)),
      level: 1,
      parent_id: null,
      children: [],
      content: "",
      summary: "",
      word_count: 0,
      line_start: 1,
      line_end: 1,
    }],
    root_nodes: [rootId],
  };
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
