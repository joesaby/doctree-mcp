/**
 * Wiki linter — scans WIKI_ROOT for health issues.
 * Called by AI tool hooks after write_wiki_entry.
 *
 * Usage:
 *   bunx doctree-mcp-lint
 *
 * Env vars:
 *   WIKI_ROOT       — directory to scan (default: ./docs/wiki, fallback: DOCS_ROOT)
 *   LINT_MIN_WORDS  — stub word threshold (default: 100)
 */

import { resolve, join, dirname, relative } from "node:path";

// ── Exported utilities (also used by tests) ──────────────────────────

export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key) fm[key] = val;
  }
  return fm;
}

export function countWords(content: string): number {
  // Strip YAML frontmatter block before counting
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return body.split(/\s+/).filter((w) => w.length > 0).length;
}

export function extractLinks(
  content: string,
  filePath: string,
  wikiRoot: string
): string[] {
  const dir = dirname(filePath);
  const links: string[] = [];
  for (const match of content.matchAll(/\[([^\]]*)\]\(([^)]+\.md[^)]*)\)/g)) {
    const href = match[2].split("#")[0]; // strip anchors
    if (href.startsWith("http://") || href.startsWith("https://")) continue;
    links.push(resolve(dir, href));
  }
  return links;
}

// ── Issue detection ──────────────────────────────────────────────────

export interface LintIssues {
  missingFrontmatter: string[];
  stubs: string[];
  orphans: string[];
  brokenLinks: string[];
}

interface FileInfo {
  absPath: string;
  relPath: string;
  frontmatter: Record<string, string>;
  wordCount: number;
  links: string[]; // resolved absolute paths
}

export async function detectIssues(
  wikiRoot: string,
  minWords: number
): Promise<LintIssues> {
  const absRoot = resolve(wikiRoot);
  const glob = new Bun.Glob("**/*.md");
  const files: FileInfo[] = [];

  for await (const relPath of glob.scan({ cwd: absRoot })) {
    const absPath = join(absRoot, relPath);
    const content = await Bun.file(absPath).text();
    files.push({
      absPath,
      relPath,
      frontmatter: parseFrontmatter(content),
      wordCount: countWords(content),
      links: extractLinks(content, absPath, absRoot),
    });
  }

  // Build set of all file absolute paths for fast lookup
  const allPaths = new Set(files.map((f) => f.absPath));

  // Build inbound link map: target → [sources]
  const inboundLinks = new Map<string, string[]>();
  for (const f of files) {
    for (const link of f.links) {
      const sources = inboundLinks.get(link) ?? [];
      sources.push(f.absPath);
      inboundLinks.set(link, sources);
    }
  }

  const missingFrontmatter: string[] = [];
  const stubs: string[] = [];
  const orphans: string[] = [];
  const brokenLinks: string[] = [];

  for (const f of files) {
    // Missing frontmatter
    const missing: string[] = [];
    if (!f.frontmatter.title) missing.push("title");
    if (!f.frontmatter.description) missing.push("description");
    if (!f.frontmatter.tags) missing.push("tags");
    if (missing.length > 0) {
      missingFrontmatter.push(`  ${f.relPath} — missing: ${missing.join(", ")}`);
    }

    // Stubs
    if (f.wordCount < minWords) {
      stubs.push(`  ${f.relPath} — ${f.wordCount} words (threshold: ${minWords})`);
    }

    // Orphaned pages (no inbound links from other wiki docs)
    if (!inboundLinks.has(f.absPath)) {
      orphans.push(`  ${f.relPath} — no other docs link here`);
    }

    // Broken cross-references
    for (const link of f.links) {
      if (!allPaths.has(link)) {
        brokenLinks.push(
          `  ${f.relPath} — broken link to ${relative(absRoot, link)}`
        );
      }
    }
  }

  return { missingFrontmatter, stubs, orphans, brokenLinks };
}

// ── Main ─────────────────────────────────────────────────────────────

export async function main() {
  const wikiRoot =
    process.env.WIKI_ROOT || process.env.DOCS_ROOT || "./docs/wiki";
  const minWords = parseInt(process.env.LINT_MIN_WORDS || "100", 10);

  const issues = await detectIssues(wikiRoot, minWords);

  const totalIssues =
    issues.missingFrontmatter.length +
    issues.stubs.length +
    issues.orphans.length +
    issues.brokenLinks.length;

  if (totalIssues === 0) {
    console.log("doctree-mcp lint: all clear");
    process.exit(0);
  }

  console.log(`doctree-mcp lint: ${totalIssues} issues found\n`);

  if (issues.missingFrontmatter.length > 0) {
    console.log(`MISSING FRONTMATTER (${issues.missingFrontmatter.length}):`);
    console.log(issues.missingFrontmatter.join("\n"));
    console.log();
  }
  if (issues.stubs.length > 0) {
    console.log(`STUBS (${issues.stubs.length}):`);
    console.log(issues.stubs.join("\n"));
    console.log();
  }
  if (issues.orphans.length > 0) {
    console.log(`ORPHANED PAGES (${issues.orphans.length}):`);
    console.log(issues.orphans.join("\n"));
    console.log();
  }
  if (issues.brokenLinks.length > 0) {
    console.log(`BROKEN LINKS (${issues.brokenLinks.length}):`);
    console.log(issues.brokenLinks.join("\n"));
    console.log();
  }

  console.log("Run /doc-lint for a guided audit with your agent.");
  process.exit(0); // Always 0 — lint is informational, never blocks the write
}

// Run only when invoked directly (not imported by tests)
if (import.meta.main) {
  main().catch(console.error);
}
