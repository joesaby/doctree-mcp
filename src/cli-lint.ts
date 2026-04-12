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
