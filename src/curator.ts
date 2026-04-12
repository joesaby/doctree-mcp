/**
 * Wiki Curation Toolset
 *
 * Three functions for agent-driven documentation authoring:
 * - findSimilar:     BM25-based duplicate detection
 * - draftWikiEntry:  Structural scaffold generation
 * - writeWikiEntry:  Validated write with safety checks
 *
 * All functions are deterministic — zero LLM calls.
 * Write operations are gated behind WIKI_WRITE=1 env var.
 */

import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { DocumentStore } from "./store";
import { indexFile } from "./indexer";
import { inferTypeFromPath } from "./indexer";

// ── Types ───────────────────────────────────────────────────────────

export interface WikiOptions {
  root: string; // Absolute path, writes confined here
  collectionName?: string; // Default "docs"
  duplicateThreshold?: number; // Default 0.35
}

export class CuratorError extends Error {
  constructor(
    public readonly code:
      | "PATH_ESCAPE"
      | "PATH_INVALID"
      | "EXISTS"
      | "FRONTMATTER_INVALID"
      | "DUPLICATE"
      | "WRITE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "CuratorError";
  }
}

// ── Similarity result types ─────────────────────────────────────────

interface SimilarMatch {
  doc_id: string;
  title: string;
  file_path: string;
  score: number;
  overlap_ratio: number;
  matched_terms: string[];
}

interface SimilarityResult {
  matches: SimilarMatch[];
  suggest_merge: boolean;
  highest_overlap: number;
}

// ── Draft result types ──────────────────────────────────────────────

interface DraftResult {
  suggested_path: string;
  frontmatter: Record<string, unknown>;
  glossary_hits: string[];
  similar_docs: SimilarMatch[];
  duplicate_warning: boolean;
}

// ── Write result types ──────────────────────────────────────────────

interface WriteResult {
  path: string;
  absolute_path: string;
  doc_id: string;
  status: "written" | "dry_run_ok";
  warnings: string[];
}

// ── Tokenization (matches store.ts tokenizer) ───────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\.\/]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

// ── findSimilar ─────────────────────────────────────────────────────

export function findSimilar(
  store: DocumentStore,
  content: string,
  options?: { threshold?: number }
): SimilarityResult {
  const threshold = options?.threshold ?? 0.35;

  // Extract unique terms from content (cap at 200 for performance)
  const contentTerms = [...new Set(tokenize(content))].slice(0, 200);

  if (contentTerms.length === 0) {
    return { matches: [], suggest_merge: false, highest_overlap: 0 };
  }

  // Use the first 10 significant terms as a search query
  const queryTerms = contentTerms.slice(0, 10).join(" ");
  const searchResults = store.searchDocuments(queryTerms, { limit: 20 });

  const contentTermSet = new Set(contentTerms);
  const matches: SimilarMatch[] = [];

  for (const result of searchResults) {
    // Compute Jaccard lower-bound overlap
    const matchedSet = new Set(result.matched_terms);
    const intersection = result.matched_terms.filter((t) =>
      contentTermSet.has(t)
    ).length;
    const union = contentTermSet.size + matchedSet.size - intersection;
    const overlap_ratio = union > 0 ? intersection / union : 0;

    if (overlap_ratio >= threshold * 0.5) {
      // Include if at least half the threshold for visibility
      matches.push({
        doc_id: result.doc_id,
        title: result.doc_title,
        file_path: result.file_path,
        score: result.score,
        overlap_ratio: Math.round(overlap_ratio * 100) / 100,
        matched_terms: result.matched_terms,
      });
    }
  }

  // Deduplicate by doc_id, keeping highest overlap
  const byDoc = new Map<string, SimilarMatch>();
  for (const m of matches) {
    const existing = byDoc.get(m.doc_id);
    if (!existing || m.overlap_ratio > existing.overlap_ratio) {
      byDoc.set(m.doc_id, m);
    }
  }

  const dedupedMatches = [...byDoc.values()]
    .sort((a, b) => b.overlap_ratio - a.overlap_ratio)
    .slice(0, 10);

  const highest_overlap =
    dedupedMatches.length > 0 ? dedupedMatches[0].overlap_ratio : 0;

  return {
    matches: dedupedMatches,
    suggest_merge: highest_overlap >= threshold,
    highest_overlap,
  };
}

// ── draftWikiEntry ──────────────────────────────────────────────────

export function draftWikiEntry(
  store: DocumentStore,
  wiki: WikiOptions,
  input: {
    topic: string;
    raw_content: string;
    suggested_path?: string;
  }
): DraftResult {
  const collectionName = wiki.collectionName ?? "docs";
  const threshold = wiki.duplicateThreshold ?? 0.35;

  // 1. Suggest a path
  const suggested_path =
    input.suggested_path || suggestPath(input.topic, collectionName);

  // 2. Check for similar documents
  const similarity = findSimilar(store, input.raw_content, { threshold });

  // 3. Infer frontmatter from similar docs and content
  const frontmatter: Record<string, unknown> = {
    title: input.topic,
    description: extractDescription(input.raw_content),
  };

  // Infer type from path
  const inferredType = inferTypeFromPath(suggested_path);
  if (inferredType) {
    frontmatter.type = inferredType;
  }

  // Infer tags from content
  const tags = inferTags(input.raw_content, similarity.matches);
  if (tags.length > 0) {
    frontmatter.tags = tags;
  }

  // Infer category from similar docs
  if (similarity.matches.length > 0) {
    const topMatch = similarity.matches[0];
    const meta = store.getDocMeta(topMatch.doc_id);
    if (meta?.facets?.category) {
      frontmatter.category = meta.facets.category[0];
    }
  }

  // 4. Check glossary terms present in content
  const glossaryTerms = store.getGlossaryTerms();
  const contentLower = input.raw_content.toLowerCase();
  const glossary_hits = glossaryTerms.filter((term) =>
    contentLower.includes(term)
  );

  return {
    suggested_path,
    frontmatter,
    glossary_hits,
    similar_docs: similarity.matches.slice(0, 5),
    duplicate_warning: similarity.suggest_merge,
  };
}

// ── writeWikiEntry ──────────────────────────────────────────────────

export async function writeWikiEntry(
  store: DocumentStore,
  wiki: WikiOptions,
  input: {
    path: string;
    frontmatter: Record<string, unknown>;
    content: string;
    dry_run?: boolean;
    overwrite?: boolean;
    allow_duplicate?: boolean;
  }
): Promise<WriteResult> {
  const collectionName = wiki.collectionName ?? "docs";
  const threshold = wiki.duplicateThreshold ?? 0.35;
  const warnings: string[] = [];

  // 1. Path validation — must be relative, end in .md
  if (input.path.startsWith("/") || input.path.startsWith("\\")) {
    throw new CuratorError("PATH_INVALID", "Path must be relative");
  }
  if (!input.path.endsWith(".md")) {
    throw new CuratorError("PATH_INVALID", "Path must end in .md");
  }
  if (input.path.includes("..")) {
    throw new CuratorError(
      "PATH_ESCAPE",
      "Path must not contain '..' segments"
    );
  }

  // 2. Resolve and verify containment
  const absolutePath = resolve(wiki.root, input.path);
  if (!absolutePath.startsWith(resolve(wiki.root))) {
    throw new CuratorError(
      "PATH_ESCAPE",
      `Resolved path escapes wiki root: ${absolutePath}`
    );
  }

  // 3. Check existence
  if (!input.overwrite && existsSync(absolutePath)) {
    throw new CuratorError(
      "EXISTS",
      `File already exists: ${input.path}. Set overwrite=true to replace.`
    );
  }

  // 4. Validate frontmatter
  validateFrontmatter(input.frontmatter);

  // 5. Duplicate check
  if (!input.allow_duplicate) {
    const similarity = findSimilar(store, input.content, { threshold });
    if (similarity.suggest_merge) {
      throw new CuratorError(
        "DUPLICATE",
        `Content overlaps ${(similarity.highest_overlap * 100).toFixed(0)}% with "${similarity.matches[0].title}" (${similarity.matches[0].doc_id}). Set allow_duplicate=true to proceed.`
      );
    }
    if (similarity.highest_overlap > threshold * 0.5) {
      warnings.push(
        `Moderate overlap (${(similarity.highest_overlap * 100).toFixed(0)}%) with "${similarity.matches[0].title}"`
      );
    }
  }

  // 6. Build the markdown file content
  const fmLines = ["---"];
  for (const [key, value] of Object.entries(input.frontmatter)) {
    if (Array.isArray(value)) {
      fmLines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
    } else if (typeof value === "string") {
      fmLines.push(`${key}: "${value}"`);
    } else {
      fmLines.push(`${key}: ${value}`);
    }
  }
  fmLines.push("---", "");
  const fullContent = fmLines.join("\n") + input.content;

  // Build doc_id
  const doc_id = `${collectionName}:${input.path.replace(/\.md$/i, "").replace(/[/\\]/g, ":")}`;

  // 7. Dry run — return validation result
  if (input.dry_run) {
    return {
      path: input.path,
      absolute_path: absolutePath,
      doc_id,
      status: "dry_run_ok",
      warnings,
    };
  }

  // 8. Write to disk
  try {
    const dir = dirname(absolutePath);
    await mkdir(dir, { recursive: true });
    await writeFile(absolutePath, fullContent, "utf-8");
  } catch (err: any) {
    throw new CuratorError(
      "WRITE_FAILED",
      `Failed to write ${absolutePath}: ${err.message}`
    );
  }

  // 9. Incremental re-index
  try {
    const doc = await indexFile(absolutePath, wiki.root, collectionName);
    store.addDocument(doc);
  } catch (err: any) {
    warnings.push(`Re-index failed: ${err.message}`);
  }

  return {
    path: input.path,
    absolute_path: absolutePath,
    doc_id,
    status: "written",
    warnings,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function validateFrontmatter(fm: Record<string, unknown>): void {
  const keyPattern = /^[a-zA-Z][\w-]*$/;
  for (const [key, value] of Object.entries(fm)) {
    if (!keyPattern.test(key)) {
      throw new CuratorError(
        "FRONTMATTER_INVALID",
        `Invalid frontmatter key: "${key}". Must match /^[a-zA-Z][\\w-]*$/.`
      );
    }
    if (value === null || value === undefined) {
      throw new CuratorError(
        "FRONTMATTER_INVALID",
        `Frontmatter key "${key}" has null/undefined value.`
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== "string") {
          throw new CuratorError(
            "FRONTMATTER_INVALID",
            `Array values in frontmatter must be strings. Key "${key}" has non-string item.`
          );
        }
        if (item.includes("\n")) {
          throw new CuratorError(
            "FRONTMATTER_INVALID",
            `Frontmatter values must not contain newlines. Key "${key}".`
          );
        }
      }
    } else if (typeof value === "string") {
      if (value.includes("\n")) {
        throw new CuratorError(
          "FRONTMATTER_INVALID",
          `Frontmatter values must not contain newlines. Key "${key}".`
        );
      }
    } else if (
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new CuratorError(
        "FRONTMATTER_INVALID",
        `Unsupported frontmatter value type for key "${key}": ${typeof value}. Must be string, number, boolean, or string[].`
      );
    }
  }
}

function suggestPath(topic: string, _collectionName: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}.md`;
}

function extractDescription(content: string): string {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  // Skip heading lines
  const firstParagraph = lines.find((l) => !l.startsWith("#"));
  if (firstParagraph) {
    return firstParagraph.trim().slice(0, 200);
  }
  return "";
}

function inferTags(
  content: string,
  similarDocs: SimilarMatch[]
): string[] {
  const tags = new Set<string>();

  // Gather tags from top similar docs' matched terms
  for (const doc of similarDocs.slice(0, 3)) {
    for (const term of doc.matched_terms.slice(0, 5)) {
      if (term.length >= 3) tags.add(term);
    }
  }

  // Cap at 10 tags
  return [...tags].slice(0, 10);
}
