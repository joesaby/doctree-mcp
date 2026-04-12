# doctree-mcp User Journey Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it trivial for any user (with or without existing docs) to set up doctree-mcp, write and curate docs via an AI agent, and search — across Claude Code, Cursor, Windsurf, Codex CLI, and OpenCode.

**Architecture:** Two new CLI binaries (`doctree-mcp-init`, `doctree-mcp-lint`) handle setup and post-write linting. Tool output formatting is improved to rich text. A new `doc-lint` MCP prompt guides wiki auditing. Docs and skills are updated to reflect the full user journey including the update workflow.

**Tech Stack:** Bun (>=1.3.8), TypeScript, Node.js built-in `readline/promises`, `node:fs/promises`, `node:path`. No new runtime dependencies.

**Spec:** `docs/specs/2026-04-12-doctree-user-journey-design.md`

---

## File Map

### New files
| File | Responsibility |
|------|----------------|
| `src/cli-init.ts` | Init CLI — detection, prompts, scaffolding, config generation |
| `src/cli-lint.ts` | Lint CLI — wiki health check, called by hooks after write |
| `bin-init.ts` | Shebang wrapper for `doctree-mcp-init` binary |
| `bin-lint.ts` | Shebang wrapper for `doctree-mcp-lint` binary |
| `tests/cli-lint.test.ts` | Unit tests for lint CLI logic |
| `tests/cli-init.test.ts` | Unit tests for init CLI logic |
| `tests/tools-format.test.ts` | Unit tests for find_similar + draft_wiki_entry rich text output |

### Modified files
| File | Change |
|------|--------|
| `package.json` | Add two `bin` entries + add bin files to `files` array |
| `src/tools.ts` | Rich text formatters for `find_similar` and `draft_wiki_entry` tool handlers |
| `src/prompts.ts` | doc-write update branch + new `doc-lint` prompt |
| `.claude/skills/doc-write/SKILL.md` | Add update workflow branch after find_similar |
| `README.md` | Full rewrite — dual entry points + per-tool setup guide |
| `docs/LLM-WIKI-GUIDE.md` | Restructure — init-first, update pattern, lint pattern |

---

## Task 1: Package setup — bin entries and wrapper files

**Files:**
- Modify: `package.json`
- Create: `bin-init.ts`
- Create: `bin-lint.ts`

- [ ] **Step 1: Add bin entries to package.json**

Open `package.json`. Change the `bin` field and add new files to `files`:

```json
{
  "bin": {
    "doctree-mcp": "bin.ts",
    "doctree-mcp-init": "bin-init.ts",
    "doctree-mcp-lint": "bin-lint.ts"
  },
  "files": [
    "src/",
    "bin.ts",
    "bin-init.ts",
    "bin-lint.ts",
    "README.md",
    "LICENSE"
  ]
}
```

- [ ] **Step 2: Create `bin-init.ts`**

```typescript
#!/usr/bin/env -S bun run
import './src/cli-init.ts'
```

- [ ] **Step 3: Create `bin-lint.ts`**

```typescript
#!/usr/bin/env -S bun run
import './src/cli-lint.ts'
```

- [ ] **Step 4: Commit**

```bash
git add package.json bin-init.ts bin-lint.ts
git commit -m "chore: add doctree-mcp-init and doctree-mcp-lint bin entries"
```

---

## Task 2: cli-lint.ts — parsing utilities

**Files:**
- Create: `src/cli-lint.ts`
- Create: `tests/cli-lint.test.ts`

- [ ] **Step 1: Write failing tests for parseFrontmatter, countWords, extractLinks**

Create `tests/cli-lint.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { parseFrontmatter, countWords, extractLinks } from "../src/cli-lint";

describe("parseFrontmatter", () => {
  test("parses title, description, tags", () => {
    const content = `---
title: "My Doc"
description: "A test"
tags: [auth, jwt]
type: guide
---

# My Doc
`;
    const fm = parseFrontmatter(content);
    expect(fm.title).toBe('"My Doc"');
    expect(fm.description).toBe('"A test"');
    expect(fm.tags).toBe("[auth, jwt]");
  });

  test("returns empty object when no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading\n")).toEqual({});
  });

  test("handles frontmatter with no trailing newline after ---", () => {
    const content = `---\ntitle: Hello\n---\ncontent`;
    expect(parseFrontmatter(content).title).toBe("Hello");
  });
});

describe("countWords", () => {
  test("strips frontmatter before counting", () => {
    const content = `---
title: "Doc"
---

Hello world foo bar`;
    expect(countWords(content)).toBe(4);
  });

  test("counts words in plain content", () => {
    expect(countWords("one two three")).toBe(3);
  });

  test("returns 0 for empty content", () => {
    expect(countWords("")).toBe(0);
  });
});

describe("extractLinks", () => {
  test("extracts relative .md links", () => {
    const content = `See [auth guide](../auth/guide.md) and [setup](setup.md)`;
    const links = extractLinks(content, "/wiki/deploy/step.md", "/wiki");
    expect(links).toContain("/wiki/auth/guide.md");
    expect(links).toContain("/wiki/deploy/setup.md");
  });

  test("ignores http links", () => {
    const content = `See [external](https://example.com) and [local](local.md)`;
    const links = extractLinks(content, "/wiki/doc.md", "/wiki");
    expect(links).toHaveLength(1);
    expect(links[0]).toContain("local.md");
  });

  test("returns empty array when no links", () => {
    expect(extractLinks("no links here", "/wiki/doc.md", "/wiki")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
bun test tests/cli-lint.test.ts
```
Expected: FAIL — `../src/cli-lint` does not exist.

- [ ] **Step 3: Create `src/cli-lint.ts` with exported utilities**

```typescript
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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test tests/cli-lint.test.ts
```
Expected: PASS (3 describe blocks, 9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli-lint.ts tests/cli-lint.test.ts
git commit -m "feat: add cli-lint parsing utilities with tests"
```

---

## Task 3: cli-lint.ts — issue detection and main function

**Files:**
- Modify: `src/cli-lint.ts`
- Modify: `tests/cli-lint.test.ts`

- [ ] **Step 1: Write failing tests for issue detection**

Append to `tests/cli-lint.test.ts`:

```typescript
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectIssues } from "../src/cli-lint";

describe("detectIssues", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "doctree-lint-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  async function writeFile(relPath: string, content: string) {
    const abs = join(dir, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await Bun.write(abs, content);
  }

  test("detects missing frontmatter fields", async () => {
    await writeFile("doc.md", "# Hello\n\nsome content here words words words words words");
    const issues = await detectIssues(dir, 5);
    expect(issues.missingFrontmatter).toHaveLength(1);
    expect(issues.missingFrontmatter[0]).toContain("doc.md");
    expect(issues.missingFrontmatter[0]).toContain("title");
  });

  test("detects stubs", async () => {
    await writeFile("stub.md", `---\ntitle: T\ndescription: D\ntags: [x]\n---\nshort`);
    const issues = await detectIssues(dir, 100);
    expect(issues.stubs).toHaveLength(1);
    expect(issues.stubs[0]).toContain("stub.md");
  });

  test("detects orphaned pages", async () => {
    await writeFile("a.md", `---\ntitle: A\ndescription: D\ntags: [x]\n---\nwords words words words words words`);
    await writeFile("b.md", `---\ntitle: B\ndescription: D\ntags: [x]\n---\nwords words words words [A](a.md)`);
    const issues = await detectIssues(dir, 5);
    // b.md is not linked from anywhere — orphan
    expect(issues.orphans.some((o) => o.includes("b.md"))).toBe(true);
    // a.md is linked from b.md — not an orphan
    expect(issues.orphans.some((o) => o.includes("a.md"))).toBe(false);
  });

  test("detects broken cross-references", async () => {
    await writeFile("doc.md", `---\ntitle: T\ndescription: D\ntags: [x]\n---\nwords words [missing](missing.md)`);
    const issues = await detectIssues(dir, 5);
    expect(issues.brokenLinks).toHaveLength(1);
    expect(issues.brokenLinks[0]).toContain("missing.md");
  });

  test("returns no issues for a clean wiki", async () => {
    await writeFile("a.md", `---\ntitle: A\ndescription: D\ntags: [x]\n---\nwords words words words words [B](b.md)`);
    await writeFile("b.md", `---\ntitle: B\ndescription: D\ntags: [x]\n---\nwords words words words words [A](a.md)`);
    const issues = await detectIssues(dir, 5);
    expect(issues.missingFrontmatter).toHaveLength(0);
    expect(issues.stubs).toHaveLength(0);
    expect(issues.orphans).toHaveLength(0);
    expect(issues.brokenLinks).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
bun test tests/cli-lint.test.ts
```
Expected: FAIL — `detectIssues` not exported.

- [ ] **Step 3: Add `detectIssues` and `main` to `src/cli-lint.ts`**

Append to `src/cli-lint.ts` after the exported utilities:

```typescript
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

async function main() {
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
```

- [ ] **Step 4: Run all lint tests**

```bash
bun test tests/cli-lint.test.ts
```
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/cli-lint.ts tests/cli-lint.test.ts
git commit -m "feat: implement cli-lint with issue detection and main"
```

---

## Task 4: cli-init.ts — directory scaffolding

**Files:**
- Create: `src/cli-init.ts`
- Create: `tests/cli-init.test.ts`

- [ ] **Step 1: Write failing test for scaffoldDirs**

Create `tests/cli-init.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { scaffoldDirs } from "../src/cli-init";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "doctree-init-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true });
});

describe("scaffoldDirs", () => {
  test("creates docs/wiki and docs/raw-sources directories", async () => {
    await scaffoldDirs(dir);
    expect(existsSync(join(dir, "docs/wiki"))).toBe(true);
    expect(existsSync(join(dir, "docs/raw-sources"))).toBe(true);
  });

  test("creates getting-started.md with frontmatter", async () => {
    await scaffoldDirs(dir);
    const content = await Bun.file(join(dir, "docs/wiki/getting-started.md")).text();
    expect(content).toContain("title:");
    expect(content).toContain("type: guide");
    expect(content).toContain("# Getting Started");
  });

  test("creates .gitkeep in raw-sources", async () => {
    await scaffoldDirs(dir);
    expect(existsSync(join(dir, "docs/raw-sources/.gitkeep"))).toBe(true);
  });

  test("does not overwrite existing getting-started.md", async () => {
    await scaffoldDirs(dir);
    await Bun.write(join(dir, "docs/wiki/getting-started.md"), "my content");
    await scaffoldDirs(dir); // run again
    const content = await Bun.file(join(dir, "docs/wiki/getting-started.md")).text();
    expect(content).toBe("my content"); // unchanged
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
bun test tests/cli-init.test.ts
```
Expected: FAIL — `../src/cli-init` does not exist.

- [ ] **Step 3: Create `src/cli-init.ts` with scaffoldDirs**

```typescript
/**
 * Init CLI — scaffolds a Karpathy-style LLM wiki and configures AI tools.
 *
 * Usage:
 *   bunx doctree-mcp-init           # interactive tool selection
 *   bunx doctree-mcp-init --all     # configure all supported tools
 *   bunx doctree-mcp-init --dry-run # print actions without writing
 */

import { resolve, join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import * as readline from "node:readline/promises";

export const WIKI_CONVENTIONS = `
## Wiki Conventions (doctree-mcp)

When writing documentation to the wiki:

1. **Check for duplicates first** — always call \`find_similar\` before creating a new page
2. **Update, don't duplicate** — if overlap > 0.35, read the existing doc with \`navigate_tree\`, merge, then \`write_wiki_entry(overwrite: true)\`
3. **Use \`draft_wiki_entry\` to scaffold** — it infers frontmatter from existing docs
4. **Follow the directory structure**:
   - \`docs/wiki/guides/\` — how-to guides and tutorials
   - \`docs/wiki/reference/\` — API docs, config reference
   - \`docs/wiki/runbooks/\` — operational procedures
5. **Include frontmatter** — title, description, tags, type, category
6. **Cross-reference** — link to related docs with relative markdown links
7. **Define acronyms inline** — "TLS (Transport Layer Security)" on first use
8. **Raw sources are immutable** — never write to \`docs/raw-sources/\`
`;

const GETTING_STARTED_MD = `---
title: "Getting Started"
description: "First wiki entry — replace with your content"
type: guide
tags: [setup]
---

# Getting Started

Add your content here. Each heading becomes a navigable section.

## What Goes Here

Drop articles, notes, or meeting summaries into \`docs/raw-sources/\` and ask your agent to create wiki entries from them.
`;

export async function scaffoldDirs(
  root: string,
  dryRun = false
): Promise<string[]> {
  const created: string[] = [];
  const wikiDir = join(root, "docs/wiki");
  const rawDir = join(root, "docs/raw-sources");
  const startingDoc = join(wikiDir, "getting-started.md");
  const gitkeep = join(rawDir, ".gitkeep");

  if (!existsSync(wikiDir)) {
    if (!dryRun) await mkdir(wikiDir, { recursive: true });
    created.push("docs/wiki/");
  }
  if (!existsSync(rawDir)) {
    if (!dryRun) await mkdir(rawDir, { recursive: true });
    created.push("docs/raw-sources/");
  }
  if (!existsSync(startingDoc)) {
    if (!dryRun) await writeFile(startingDoc, GETTING_STARTED_MD);
    created.push("docs/wiki/getting-started.md");
  }
  if (!existsSync(gitkeep)) {
    if (!dryRun) await writeFile(gitkeep, "");
    created.push("docs/raw-sources/.gitkeep");
  }

  return created;
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
bun test tests/cli-init.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli-init.ts tests/cli-init.test.ts
git commit -m "feat: add cli-init scaffoldDirs with tests"
```

---

## Task 5: cli-init.ts — MCP config generators

**Files:**
- Modify: `src/cli-init.ts`
- Modify: `tests/cli-init.test.ts`

- [ ] **Step 1: Write failing tests for MCP config generation**

Append to `tests/cli-init.test.ts`:

```typescript
import {
  generateMcpConfig,
  type Tool,
} from "../src/cli-init";

describe("generateMcpConfig", () => {
  test("claude-code: generates .mcp.json content", () => {
    const result = generateMcpConfig("claude-code");
    const parsed = JSON.parse(result.content);
    expect(result.path).toBe(".mcp.json");
    expect(parsed.mcpServers.doctree.command).toBe("bunx");
    expect(parsed.mcpServers.doctree.args).toContain("doctree-mcp");
    expect(parsed.mcpServers.doctree.env.DOCS_ROOTS).toContain("docs/wiki:1.0");
    expect(parsed.mcpServers.doctree.env.WIKI_WRITE).toBe("1");
  });

  test("cursor: generates .cursor/mcp.json", () => {
    const result = generateMcpConfig("cursor");
    expect(result.path).toBe(".cursor/mcp.json");
    const parsed = JSON.parse(result.content);
    expect(parsed.mcpServers.doctree.env.DOCS_ROOTS).toContain("docs/wiki:1.0");
  });

  test("windsurf: generates .windsurf/mcp.json", () => {
    const result = generateMcpConfig("windsurf");
    expect(result.path).toBe(".windsurf/mcp.json");
  });

  test("codex: generates .codex/config.toml with TOML format", () => {
    const result = generateMcpConfig("codex");
    expect(result.path).toBe(".codex/config.toml");
    expect(result.content).toContain("[mcp_servers.doctree]");
    expect(result.content).toContain("DOCS_ROOTS");
    expect(result.content).toContain("WIKI_WRITE");
  });

  test("opencode: generates opencode.json", () => {
    const result = generateMcpConfig("opencode");
    expect(result.path).toBe("opencode.json");
    const parsed = JSON.parse(result.content);
    expect(parsed.mcp?.servers?.doctree).toBeDefined();
  });

  test("claude-desktop: returns null (no project file)", () => {
    const result = generateMcpConfig("claude-desktop");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
bun test tests/cli-init.test.ts --testNamePattern "generateMcpConfig"
```
Expected: FAIL — `generateMcpConfig` not exported.

- [ ] **Step 3: Add Tool type and generateMcpConfig to `src/cli-init.ts`**

Append after `scaffoldDirs`:

```typescript
export type Tool =
  | "claude-code"
  | "cursor"
  | "windsurf"
  | "codex"
  | "opencode"
  | "claude-desktop";

export const TOOL_LABELS: Record<Tool, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  windsurf: "Windsurf",
  codex: "Codex CLI",
  opencode: "OpenCode",
  "claude-desktop": "Claude Desktop (read-only, manual setup)",
};

const MCP_ENV = {
  DOCS_ROOTS: "./docs/wiki:1.0,./docs/raw-sources:0.3",
  WIKI_WRITE: "1",
};

const MCP_JSON_SERVER = {
  command: "bunx",
  args: ["doctree-mcp"],
  env: MCP_ENV,
};

interface GeneratedFile {
  path: string;
  content: string;
}

export function generateMcpConfig(tool: Tool): GeneratedFile | null {
  switch (tool) {
    case "claude-code":
      return {
        path: ".mcp.json",
        content: JSON.stringify({ mcpServers: { doctree: MCP_JSON_SERVER } }, null, 2),
      };
    case "cursor":
      return {
        path: ".cursor/mcp.json",
        content: JSON.stringify({ mcpServers: { doctree: MCP_JSON_SERVER } }, null, 2),
      };
    case "windsurf":
      return {
        path: ".windsurf/mcp.json",
        content: JSON.stringify({ mcpServers: { doctree: MCP_JSON_SERVER } }, null, 2),
      };
    case "opencode":
      return {
        path: "opencode.json",
        content: JSON.stringify(
          {
            mcp: {
              servers: {
                doctree: { command: "bunx", args: ["doctree-mcp"], env: MCP_ENV },
              },
            },
          },
          null,
          2
        ),
      };
    case "codex":
      return {
        path: ".codex/config.toml",
        content: [
          "[mcp_servers.doctree]",
          `command = "bunx"`,
          `args = ["doctree-mcp"]`,
          "",
          "[mcp_servers.doctree.env]",
          `DOCS_ROOTS = "${MCP_ENV.DOCS_ROOTS}"`,
          `WIKI_WRITE = "${MCP_ENV.WIKI_WRITE}"`,
        ].join("\n"),
      };
    case "claude-desktop":
      return null; // No project-level file; CLI will print manual instructions
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test tests/cli-init.test.ts --testNamePattern "generateMcpConfig"
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli-init.ts tests/cli-init.test.ts
git commit -m "feat: add MCP config generators for all AI tools"
```

---

## Task 6: cli-init.ts — hook config generators

**Files:**
- Modify: `src/cli-init.ts`
- Modify: `tests/cli-init.test.ts`

- [ ] **Step 1: Write failing tests for hook config generation**

Append to `tests/cli-init.test.ts`:

```typescript
import { generateHookConfig } from "../src/cli-init";

describe("generateHookConfig", () => {
  test("claude-code: PostToolUse matcher on write_wiki_entry", () => {
    const result = generateHookConfig("claude-code");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    const postHooks = parsed.hooks?.PostToolUse;
    expect(postHooks).toBeDefined();
    expect(postHooks[0].matcher).toBe("write_wiki_entry");
    expect(postHooks[0].hooks[0].command).toContain("doctree-mcp-lint");
  });

  test("cursor: afterMCPExecution event", () => {
    const result = generateHookConfig("cursor");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.version).toBe(1);
    expect(parsed.hooks.afterMCPExecution).toBeDefined();
  });

  test("windsurf: post_mcp_tool_use event", () => {
    const result = generateHookConfig("windsurf");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.hooks.post_mcp_tool_use).toBeDefined();
  });

  test("opencode: generates JS plugin file", () => {
    const result = generateHookConfig("opencode");
    expect(result).not.toBeNull();
    expect(result!.path).toBe(".opencode/plugins/doctree-lint.js");
    expect(result!.content).toContain("tool.execute.after");
    expect(result!.content).toContain("write_wiki_entry");
    expect(result!.content).toContain("doctree-mcp-lint");
  });

  test("codex: PostToolUse with caveat note in comment", () => {
    const result = generateHookConfig("codex");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.hooks?.PostToolUse).toBeDefined();
  });

  test("claude-desktop: returns null", () => {
    expect(generateHookConfig("claude-desktop")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
bun test tests/cli-init.test.ts --testNamePattern "generateHookConfig"
```
Expected: FAIL — `generateHookConfig` not exported.

- [ ] **Step 3: Add generateHookConfig to `src/cli-init.ts`**

Append after `generateMcpConfig`:

```typescript
export function generateHookConfig(tool: Tool): GeneratedFile | null {
  switch (tool) {
    case "claude-code":
      return {
        path: ".claude/settings.json",
        content: JSON.stringify(
          {
            hooks: {
              PostToolUse: [
                {
                  matcher: "write_wiki_entry",
                  hooks: [{ type: "command", command: "bunx doctree-mcp-lint" }],
                },
              ],
            },
          },
          null,
          2
        ),
      };

    case "cursor":
      return {
        path: ".cursor/hooks.json",
        content: JSON.stringify(
          {
            version: 1,
            hooks: {
              afterMCPExecution: [{ command: "bunx doctree-mcp-lint" }],
            },
          },
          null,
          2
        ),
      };

    case "windsurf":
      return {
        path: ".windsurf/hooks.json",
        content: JSON.stringify(
          {
            hooks: {
              // Windsurf cannot filter by MCP tool name — runs on all MCP calls.
              // doctree-mcp-lint exits quickly when there are no issues.
              post_mcp_tool_use: [{ command: "bunx doctree-mcp-lint" }],
            },
          },
          null,
          2
        ),
      };

    case "opencode":
      return {
        path: ".opencode/plugins/doctree-lint.js",
        content: [
          "// doctree-mcp lint plugin — runs after write_wiki_entry MCP tool calls",
          "export const DoctreeLintPlugin = async ({ $ }) => ({",
          '  "tool.execute.after": async (event) => {',
          '    if (event?.tool?.name === "write_wiki_entry") {',
          "      try { await $`bunx doctree-mcp-lint`; } catch {}",
          "    }",
          "  },",
          "});",
        ].join("\n"),
      };

    case "codex":
      // Note: Codex hooks only intercept Bash tool calls as of April 2026.
      // MCP tool interception is not yet supported. This config is written
      // for forward-compatibility when Codex adds MCP hook support.
      return {
        path: ".codex/hooks.json",
        content: JSON.stringify(
          {
            // TODO: Update matcher when Codex supports MCP tool name filtering
            hooks: {
              PostToolUse: [
                {
                  matcher: "Bash",
                  hooks: [
                    {
                      type: "command",
                      command:
                        "# Codex MCP hooks not yet supported. Remove this comment when available.\n# bunx doctree-mcp-lint",
                    },
                  ],
                },
              ],
            },
          },
          null,
          2
        ),
      };

    case "claude-desktop":
      return null;
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test tests/cli-init.test.ts --testNamePattern "generateHookConfig"
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli-init.ts tests/cli-init.test.ts
git commit -m "feat: add hook config generators for all AI tools"
```

---

## Task 7: cli-init.ts — agent instruction generators

**Files:**
- Modify: `src/cli-init.ts`
- Modify: `tests/cli-init.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/cli-init.test.ts`:

```typescript
import { generateAgentInstructions } from "../src/cli-init";

describe("generateAgentInstructions", () => {
  test("claude-code: appends to CLAUDE.md (creates if missing)", () => {
    const result = generateAgentInstructions("claude-code");
    expect(result.path).toBe("CLAUDE.md");
    expect(result.append).toBe(true);
    expect(result.content).toContain("Wiki Conventions");
    expect(result.content).toContain("find_similar");
    expect(result.content).toContain("navigate_tree");
  });

  test("cursor: creates .cursor/rules/doctree-wiki.mdc with frontmatter", () => {
    const result = generateAgentInstructions("cursor");
    expect(result.path).toBe(".cursor/rules/doctree-wiki.mdc");
    expect(result.append).toBe(false);
    expect(result.content).toContain("alwaysApply: false");
    expect(result.content).toContain("Wiki Conventions");
  });

  test("windsurf: appends to CLAUDE.md (same as claude-code)", () => {
    const result = generateAgentInstructions("windsurf");
    expect(result.path).toBe("CLAUDE.md");
    expect(result.append).toBe(true);
  });

  test("codex: creates AGENTS.md", () => {
    const result = generateAgentInstructions("codex");
    expect(result.path).toBe("AGENTS.md");
    expect(result.append).toBe(false);
    expect(result.content).toContain("Wiki Conventions");
  });

  test("opencode: returns null (no standard rules file)", () => {
    expect(generateAgentInstructions("opencode")).toBeNull();
  });

  test("claude-desktop: returns null (read-only, no write tools)", () => {
    expect(generateAgentInstructions("claude-desktop")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
bun test tests/cli-init.test.ts --testNamePattern "generateAgentInstructions"
```
Expected: FAIL.

- [ ] **Step 3: Add generateAgentInstructions to `src/cli-init.ts`**

Append after `generateHookConfig`:

```typescript
interface InstructionFile {
  path: string;
  content: string;
  append: boolean; // true = append to existing file; false = create new
}

export function generateAgentInstructions(
  tool: Tool
): InstructionFile | null {
  switch (tool) {
    case "claude-code":
    case "windsurf":
      return {
        path: "CLAUDE.md",
        content: WIKI_CONVENTIONS,
        append: true,
      };

    case "cursor":
      return {
        path: ".cursor/rules/doctree-wiki.mdc",
        content: [
          "---",
          "description: doctree-mcp wiki conventions — duplicate checking, update workflow, frontmatter",
          "alwaysApply: false",
          "---",
          WIKI_CONVENTIONS,
        ].join("\n"),
        append: false,
      };

    case "codex":
      return {
        path: "AGENTS.md",
        content: `# Agent Instructions\n${WIKI_CONVENTIONS}`,
        append: false,
      };

    case "opencode":
    case "claude-desktop":
      return null;
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
bun test tests/cli-init.test.ts --testNamePattern "generateAgentInstructions"
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli-init.ts tests/cli-init.test.ts
git commit -m "feat: add agent instruction generators for all AI tools"
```

---

## Task 8: cli-init.ts — detection, file writing, and main

**Files:**
- Modify: `src/cli-init.ts`
- Modify: `tests/cli-init.test.ts`

- [ ] **Step 1: Write failing tests for detectTools and writeConfigFiles**

Append to `tests/cli-init.test.ts`:

```typescript
import { detectTools, writeConfigFiles } from "../src/cli-init";

describe("detectTools", () => {
  test("detects claude-code when .mcp.json exists", async () => {
    await Bun.write(join(dir, ".mcp.json"), "{}");
    const tools = detectTools(dir);
    expect(tools).toContain("claude-code");
  });

  test("detects cursor when .cursor dir exists", async () => {
    await mkdir(join(dir, ".cursor"), { recursive: true });
    const tools = detectTools(dir);
    expect(tools).toContain("cursor");
  });

  test("returns empty array when nothing detected", () => {
    expect(detectTools(dir)).toEqual([]);
  });
});

describe("writeConfigFiles", () => {
  test("writes MCP config file for claude-code", async () => {
    const created = await writeConfigFiles(["claude-code"], dir, false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    expect(created.some((c) => c.includes(".mcp.json"))).toBe(true);
  });

  test("does not overwrite existing MCP config", async () => {
    await Bun.write(join(dir, ".mcp.json"), '{"existing": true}');
    await writeConfigFiles(["claude-code"], dir, false);
    const content = await Bun.file(join(dir, ".mcp.json")).text();
    expect(JSON.parse(content).existing).toBe(true);
  });

  test("dry-run: does not write any files", async () => {
    await writeConfigFiles(["claude-code", "cursor"], dir, true);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(dir, ".cursor/mcp.json"))).toBe(false);
  });

  test("appends wiki conventions to CLAUDE.md without duplicating", async () => {
    await writeConfigFiles(["claude-code"], dir, false);
    await writeConfigFiles(["claude-code"], dir, false); // run twice
    const content = await Bun.file(join(dir, "CLAUDE.md")).text();
    // Should only contain one copy of the conventions marker
    const occurrences = (content.match(/Wiki Conventions \(doctree-mcp\)/g) || []).length;
    expect(occurrences).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
bun test tests/cli-init.test.ts --testNamePattern "detectTools|writeConfigFiles"
```
Expected: FAIL.

- [ ] **Step 3: Add detectTools, writeConfigFiles, and main to `src/cli-init.ts`**

Append after `generateAgentInstructions`:

```typescript
export function detectTools(root: string): Tool[] {
  const detected: Tool[] = [];
  if (existsSync(join(root, ".mcp.json")) || existsSync(join(root, ".claude")))
    detected.push("claude-code");
  if (existsSync(join(root, ".cursor"))) detected.push("cursor");
  if (existsSync(join(root, ".windsurf")) || existsSync(join(root, ".windsurfrules")))
    detected.push("windsurf");
  if (existsSync(join(root, "AGENTS.md")) || existsSync(join(root, ".codex")))
    detected.push("codex");
  if (existsSync(join(root, "opencode.json")) || existsSync(join(root, ".opencode")))
    detected.push("opencode");
  return detected;
}

export async function writeConfigFiles(
  tools: Tool[],
  root: string,
  dryRun: boolean
): Promise<string[]> {
  const created: string[] = [];

  for (const tool of tools) {
    // MCP config
    const mcp = generateMcpConfig(tool);
    if (mcp) {
      const absPath = join(root, mcp.path);
      if (!existsSync(absPath)) {
        if (!dryRun) {
          await mkdir(dirname(absPath), { recursive: true });
          await writeFile(absPath, mcp.content);
        }
        created.push(mcp.path);
      }
    }

    // Hook config
    const hook = generateHookConfig(tool);
    if (hook) {
      const absPath = join(root, hook.path);
      if (!existsSync(absPath)) {
        if (!dryRun) {
          await mkdir(dirname(absPath), { recursive: true });
          await writeFile(absPath, hook.content);
        }
        created.push(hook.path);
      }
    }

    // Agent instructions
    const instr = generateAgentInstructions(tool);
    if (instr) {
      const absPath = join(root, instr.path);
      if (instr.append) {
        // Append only if the conventions block isn't already present
        const marker = "Wiki Conventions (doctree-mcp)";
        if (!dryRun) {
          const existing = existsSync(absPath)
            ? await readFile(absPath, "utf-8")
            : "";
          if (!existing.includes(marker)) {
            await appendFile(absPath, instr.content);
            created.push(instr.path + " (appended)");
          }
        } else {
          created.push(instr.path + " (would append)");
        }
      } else {
        if (!existsSync(absPath)) {
          if (!dryRun) {
            await mkdir(dirname(absPath), { recursive: true });
            await writeFile(absPath, instr.content);
          }
          created.push(instr.path);
        }
      }
    }
  }

  return created;
}

async function promptTools(
  detected: Tool[],
  root: string
): Promise<Tool[]> {
  const allTools: Tool[] = [
    "claude-code", "cursor", "windsurf", "codex", "opencode", "claude-desktop",
  ];

  console.log("\nWhich AI tools do you use in this project?");
  allTools.forEach((tool, i) => {
    const mark = detected.includes(tool) ? " (detected)" : "";
    console.log(`  [${i + 1}] ${TOOL_LABELS[tool]}${mark}`);
  });
  console.log();

  const defaultNums =
    detected.length > 0
      ? detected.map((t) => String(allTools.indexOf(t) + 1)).join(" ")
      : "1";

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(
    `Enter numbers separated by spaces [${defaultNums}]: `
  );
  rl.close();

  if (answer.trim() === "") {
    return detected.length > 0 ? detected : ["claude-code"];
  }

  return answer
    .trim()
    .split(/\s+/)
    .map((n) => parseInt(n, 10) - 1)
    .filter((i) => i >= 0 && i < allTools.length)
    .map((i) => allTools[i]);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = Bun.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const root = process.cwd();

  console.log("doctree-mcp init");
  if (dryRun) console.log("(dry run — no files will be written)\n");

  const detected = detectTools(root);
  const tools: Tool[] = all
    ? ["claude-code", "cursor", "windsurf", "codex", "opencode"]
    : await promptTools(detected, root);

  // Scaffold directory structure
  const scaffolded = await scaffoldDirs(root, dryRun);

  // Write configs for selected tools
  const configured = await writeConfigFiles(tools, root, dryRun);

  // Claude Desktop: print manual instructions
  if (tools.includes("claude-desktop")) {
    console.log("\nClaude Desktop — add to ~/Library/Application Support/Claude/claude_desktop_config.json:");
    console.log(JSON.stringify(
      { mcpServers: { doctree: { command: "bunx", args: ["doctree-mcp"], env: { DOCS_ROOT: "/absolute/path/to/docs/wiki", WIKI_WRITE: "1" } } } },
      null, 2
    ));
  }

  const allCreated = [...scaffolded, ...configured];
  if (allCreated.length === 0) {
    console.log("\nAll configs already exist — nothing to do.");
  } else {
    console.log("\nCreated:");
    for (const f of allCreated) console.log(`  ${f}`);
  }

  console.log("\nNext steps:");
  console.log("  1. Restart your AI tool to pick up the new MCP config");
  console.log('  2. Ask your agent: "Read [article] and create a wiki entry"');
  console.log("  3. Your agent uses: find_similar → draft_wiki_entry → write_wiki_entry");
}

if (import.meta.main) {
  main().catch(console.error);
}
```

- [ ] **Step 4: Run all cli-init tests**

```bash
bun test tests/cli-init.test.ts
```
Expected: PASS (all tests green).

- [ ] **Step 5: Run full test suite**

```bash
bun test
```
Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli-init.ts tests/cli-init.test.ts
git commit -m "feat: complete cli-init with detection, prompts, and main"
```

---

## Task 9: tools.ts — rich text output for find_similar

**Files:**
- Modify: `src/tools.ts`
- Create: `tests/tools-format.test.ts`

- [ ] **Step 1: Write failing test for formatFindSimilarResult**

Create `tests/tools-format.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { formatFindSimilarResult, formatDraftResult } from "../src/tools";

describe("formatFindSimilarResult", () => {
  test("formats matches above threshold with merge suggestion", () => {
    const result = {
      matches: [
        {
          doc_id: "docs:auth:middleware",
          title: "Auth Middleware",
          file_path: "docs/wiki/auth/middleware.md",
          score: 12.4,
          overlap_ratio: 0.42,
          matched_terms: ["jwt", "auth"],
        },
        {
          doc_id: "docs:auth:oauth",
          title: "OAuth Flow",
          file_path: "docs/wiki/auth/oauth.md",
          score: 5.1,
          overlap_ratio: 0.18,
          matched_terms: ["auth"],
        },
      ],
      suggest_merge: true,
      highest_overlap: 0.42,
    };
    const text = formatFindSimilarResult(result, 0.35);
    expect(text).toContain("[overlap: 0.42]");
    expect(text).toContain("Auth Middleware");
    expect(text).toContain("middleware.md");
    expect(text).toContain("Consider updating");
    expect(text).toContain("[overlap: 0.18]");
    expect(text).toContain("navigate_tree");
  });

  test("formats empty matches", () => {
    const result = { matches: [], suggest_merge: false, highest_overlap: 0 };
    const text = formatFindSimilarResult(result, 0.35);
    expect(text).toContain("No similar documents found");
  });

  test("shows all matches but only flags ones above threshold", () => {
    const result = {
      matches: [
        { doc_id: "docs:a", title: "A", file_path: "a.md", score: 1, overlap_ratio: 0.5, matched_terms: [] },
        { doc_id: "docs:b", title: "B", file_path: "b.md", score: 1, overlap_ratio: 0.1, matched_terms: [] },
      ],
      suggest_merge: true,
      highest_overlap: 0.5,
    };
    const text = formatFindSimilarResult(result, 0.35);
    expect(text).toContain("[overlap: 0.50]");
    expect(text).toContain("[overlap: 0.10]");
    // Only the high-overlap match gets the update suggestion
    expect(text.indexOf("Consider updating")).toBeLessThan(text.indexOf("[overlap: 0.10]"));
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
bun test tests/tools-format.test.ts
```
Expected: FAIL — `formatFindSimilarResult` not exported from `src/tools.ts`.

- [ ] **Step 3: Add formatFindSimilarResult to `src/tools.ts`**

Add these two exported functions near the top of `src/tools.ts`, before `registerTools`:

```typescript
// ── Rich text formatters for curation tool output ─────────────────

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

export function formatFindSimilarResult(
  result: SimilarityResult,
  threshold: number
): string {
  if (result.matches.length === 0) {
    return `No similar documents found. Safe to create a new entry.`;
  }

  const lines: string[] = [`Found ${result.matches.length} similar document(s):\n`];

  for (const m of result.matches) {
    const overlapStr = m.overlap_ratio.toFixed(2);
    lines.push(`  [overlap: ${overlapStr}] ${m.doc_id} — ${m.title}`);
    lines.push(`    Path: ${m.file_path}`);
    if (m.overlap_ratio >= threshold) {
      lines.push(
        `    ⚠ Consider updating this doc instead of creating a new one.`
      );
      lines.push(
        `    → navigate_tree("${m.doc_id}", "<root_node_id>") to read it`
      );
    }
    lines.push("");
  }

  if (result.suggest_merge) {
    lines.push(
      `Overlap above threshold (${threshold}). Recommended: read the existing doc,\nmerge your new content, then write_wiki_entry(overwrite: true).`
    );
  } else {
    lines.push(`No duplicates above threshold (${threshold}). Safe to create a new entry.`);
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Update `find_similar` tool handler in `registerCurationTools`**

Find the `find_similar` tool handler in `registerCurationTools` (around line 275) and replace `JSON.stringify(result, null, 2)` with the formatter:

```typescript
// BEFORE:
text: JSON.stringify(result, null, 2),

// AFTER:
text: formatFindSimilarResult(result, threshold),
```

- [ ] **Step 5: Run tests — expect pass**

```bash
bun test tests/tools-format.test.ts --testNamePattern "formatFindSimilarResult"
```
Expected: PASS.

- [ ] **Step 6: Run full suite**

```bash
bun test
```
Expected: All passing.

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts tests/tools-format.test.ts
git commit -m "feat: rich text output for find_similar tool"
```

---

## Task 10: tools.ts — rich text output for draft_wiki_entry

**Files:**
- Modify: `src/tools.ts`
- Modify: `tests/tools-format.test.ts`

- [ ] **Step 1: Write failing test for formatDraftResult**

Append to `tests/tools-format.test.ts`:

```typescript
describe("formatDraftResult", () => {
  test("formats draft with all fields", () => {
    const result = {
      suggested_path: "docs/wiki/auth/jwt-validation.md",
      frontmatter: {
        title: "JWT Validation",
        description: "How JWT tokens are validated",
        type: "reference",
        category: "auth",
        tags: ["jwt", "auth", "middleware"],
      },
      glossary_hits: ["JWT → JSON Web Token"],
      similar_docs: [
        {
          doc_id: "docs:auth:middleware",
          title: "Auth Middleware",
          file_path: "auth/middleware.md",
          score: 5,
          overlap_ratio: 0.42,
          matched_terms: [],
        },
      ],
      duplicate_warning: true,
    };
    const text = formatDraftResult(result);
    expect(text).toContain("Wiki Entry Draft");
    expect(text).toContain("jwt-validation.md");
    expect(text).toContain("JWT Validation");
    expect(text).toContain("reference");
    expect(text).toContain("JWT → JSON Web Token");
    expect(text).toContain("Auth Middleware");
    expect(text).toContain("⚠ Warning");
  });

  test("formats draft with no similar docs or glossary hits", () => {
    const result = {
      suggested_path: "docs/wiki/setup.md",
      frontmatter: { title: "Setup", type: "guide", tags: ["setup"] },
      glossary_hits: [],
      similar_docs: [],
      duplicate_warning: false,
    };
    const text = formatDraftResult(result);
    expect(text).toContain("setup.md");
    expect(text).not.toContain("Glossary hits");
    expect(text).not.toContain("⚠ Warning");
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
bun test tests/tools-format.test.ts --testNamePattern "formatDraftResult"
```
Expected: FAIL.

- [ ] **Step 3: Add formatDraftResult to `src/tools.ts`**

Add after `formatFindSimilarResult`:

```typescript
interface DraftResult {
  suggested_path: string;
  frontmatter: Record<string, unknown>;
  glossary_hits: string[];
  similar_docs: SimilarMatch[];
  duplicate_warning: boolean;
}

export function formatDraftResult(result: DraftResult): string {
  const lines: string[] = ["Wiki Entry Draft\n"];

  lines.push(`  Suggested path:  ${result.suggested_path}`);

  const fm = result.frontmatter;
  if (fm.type) lines.push(`  Inferred type:   ${fm.type}`);
  if (fm.category) lines.push(`  Inferred category: ${fm.category}`);
  if (Array.isArray(fm.tags) && fm.tags.length > 0) {
    lines.push(`  Suggested tags:  ${fm.tags.join(", ")}`);
  }

  lines.push("\n  Frontmatter:");
  for (const [k, v] of Object.entries(fm)) {
    const val = Array.isArray(v) ? `[${v.join(", ")}]` : String(v);
    lines.push(`    ${k}: ${val}`);
  }

  if (result.glossary_hits.length > 0) {
    lines.push(`\n  Glossary hits: ${result.glossary_hits.join(", ")}`);
  }

  if (result.similar_docs.length > 0) {
    lines.push("\n  Related docs (backlinks to include):");
    for (const d of result.similar_docs) {
      lines.push(`    - ${d.file_path}`);
    }
  }

  if (result.duplicate_warning) {
    const top = result.similar_docs[0];
    lines.push(
      `\n  ⚠ Warning: Similar content exists in ${top?.file_path ?? "an existing doc"} (overlap: ${top?.overlap_ratio ?? "?"}).`
    );
    lines.push(
      `    Consider updating the existing doc instead (use the update workflow).`
    );
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Update `draft_wiki_entry` tool handler in `registerCurationTools`**

Find the `draft_wiki_entry` handler and replace `JSON.stringify(result, null, 2)` with:

```typescript
text: formatDraftResult(result),
```

- [ ] **Step 5: Run all format tests**

```bash
bun test tests/tools-format.test.ts
```
Expected: PASS (all tests).

- [ ] **Step 6: Run full suite**

```bash
bun test
```
Expected: All passing.

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts tests/tools-format.test.ts
git commit -m "feat: rich text output for draft_wiki_entry tool"
```

---

## Task 11: prompts.ts — doc-write update branch and doc-lint prompt

**Files:**
- Modify: `src/prompts.ts`

No unit tests needed — prompt content is string templates tested via review.

- [ ] **Step 1: Add update-branch to doc-write prompt in `src/prompts.ts`**

Find the `doc-write` prompt's Step 1 content (around line 103). Replace the current find_similar step text block with:

```typescript
"## Step 1: Check for duplicates",
"Call find_similar with the content you plan to write.",
"",
"**If overlap > 0.35 — UPDATE WORKFLOW (don't create a new doc):**",
"1. Call navigate_tree(doc_id, root_node_id) to read the existing doc fully",
"2. Identify which sections to update, which to keep",
"3. Compose the full merged content (existing + new information)",
`4. Call write_wiki_entry(path: "<existing file path>", ..., overwrite: true)`,
"   — use the same path as the existing file",
"",
"**If overlap < 0.35 — proceed to Step 2 (scaffold a new entry):**",
```

- [ ] **Step 2: Add doc-lint prompt to `registerPrompts` in `src/prompts.ts`**

Add after the `doc-write` prompt registration (before the closing `}`):

```typescript
// ── Prompt 3: doc-lint ──────────────────────────────────────────────
server.registerPrompt("doc-lint", {
  title: "Audit Wiki Health",
  description:
    "Audit the wiki for orphaned pages, stubs, and missing frontmatter. Guides the agent through a health check using existing search and navigation tools.",
  argsSchema: {},
}, () => ({
  messages: [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text: [
          "Perform a wiki health audit using the doctree-mcp tools.",
          "",
          "## Step 1: Find orphaned pages",
          "Call list_documents() with no filters.",
          "Look for documents with no cross-references (the 'links to:' field is absent or empty).",
          "These are candidates for orphaned pages — nothing links to them.",
          "",
          "## Step 2: Find stubs",
          "In the list_documents results, look for documents with very low word counts (< 100 words).",
          "Call get_tree on each to confirm they are genuinely sparse.",
          "",
          "## Step 3: Check frontmatter completeness",
          "For any documents flagged in steps 1 or 2, call get_node_content on the root node.",
          "Check whether the content has: title, description, tags, type, category in the frontmatter.",
          "",
          "## Step 4: Report and act",
          "Summarize what you found:",
          "- Orphaned pages: suggest adding cross-references from related docs",
          "- Stubs: suggest expanding with more content or merging into a related doc",
          "- Missing frontmatter: suggest the missing fields based on the content",
          "",
          "For each issue, ask the user whether to fix it now or skip.",
        ].join("\n"),
      },
    },
  ],
}));
```

- [ ] **Step 3: Verify prompts.ts compiles**

```bash
bun run src/server.ts --help 2>&1 | head -5 || echo "Server started (expected)"
```
Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/prompts.ts
git commit -m "feat: add update workflow to doc-write prompt and new doc-lint prompt"
```

---

## Task 12: doc-write skill — add update workflow branch

**Files:**
- Modify: `.claude/skills/doc-write/SKILL.md`

- [ ] **Step 1: Update Step 1 in `.claude/skills/doc-write/SKILL.md`**

Find the current Step 1 content (after `find_similar` call, the "If matches are found" block). Replace the existing "decide" guidance with:

```markdown
If matches are found with **overlap > 0.35** — **UPDATE WORKFLOW**:

1. **Read the existing doc** — call `navigate_tree(doc_id, root_node_id)` to get the full content
2. **Decide what to keep vs. replace** — identify sections that overlap with your new content
3. **Compose the merged content** — write the full updated markdown (don't just append)
4. **Overwrite** — call `write_wiki_entry` with the same path and `overwrite: true`:

```
write_wiki_entry(
  path: "<same path as existing file>",
  frontmatter: { ... },   ← keep existing frontmatter, update tags if needed
  content: "<full merged content>",
  overwrite: true
)
```

If overlap is **below 0.35** — proceed to Step 2 (scaffold a new entry).
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/doc-write/SKILL.md
git commit -m "docs: add update workflow branch to doc-write skill"
```

---

## Task 13: README rewrite

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the new README.md**

Replace the entire content of `README.md` with:

```markdown
# doctree-mcp

Give your AI agent a markdown knowledge base it can search, browse, and write to — no vector DB, no embeddings, no LLM calls at index time.

doctree-mcp is an [MCP](https://modelcontextprotocol.io/) server that indexes your markdown files and exposes them as structured tools. Your agent gets BM25 search, a navigable table of contents, and (optionally) the ability to write and maintain docs.

---

## Quick Start

### Already have docs?

1. Point `DOCS_ROOT` at your markdown folder in your AI tool's MCP config (see [Setup by AI Tool](#setup-by-ai-tool) below)
2. Restart your AI tool
3. Ask your agent: *"Search the docs for X"* or use the `doc-read` MCP prompt

### Starting fresh? (LLM Wiki)

Run the init command in your project root:

```bash
bunx doctree-mcp-init
```

This scaffolds the [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) three-layer structure and configures your AI tool(s) automatically:

- Creates `docs/wiki/` (LLM-maintained) and `docs/raw-sources/` (your inputs)
- Writes MCP config for your selected AI tool(s)
- Installs a post-write lint hook so your agent gets health warnings automatically
- Appends wiki conventions to `CLAUDE.md` / `AGENTS.md` / `.cursor/rules/`

```bash
bunx doctree-mcp-init --all     # configure all supported tools
bunx doctree-mcp-init --dry-run # preview without writing
```

See [docs/LLM-WIKI-GUIDE.md](docs/LLM-WIKI-GUIDE.md) for the full walkthrough.

---

## Setup by AI Tool

All tools use the same MCP server. Replace `./docs` with your actual docs path.

### Claude Code

Add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bunx",
      "args": ["doctree-mcp"],
      "env": {
        "DOCS_ROOT": "./docs",
        "WIKI_WRITE": "1"
      }
    }
  }
}
```

**Workflow prompts:** Use `/doc-read`, `/doc-write`, `/doc-lint` slash commands (skills included in this repo).

**Lint hook** — add to `.claude/settings.json` to get health warnings after every write:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "write_wiki_entry",
        "hooks": [{ "type": "command", "command": "bunx doctree-mcp-lint" }]
      }
    ]
  }
}
```

---

### Cursor

Add `.cursor/mcp.json` to your project root:

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bunx",
      "args": ["doctree-mcp"],
      "env": {
        "DOCS_ROOT": "./docs",
        "WIKI_WRITE": "1"
      }
    }
  }
}
```

**Workflow prompts:** Use the `doc-read`, `doc-write`, and `doc-lint` MCP prompts from the chat panel.

**Lint hook** — add to `.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "afterMCPExecution": [{ "command": "bunx doctree-mcp-lint" }]
  }
}
```

**Rules** — commit `.cursor/rules/doctree-wiki.mdc` with your wiki conventions (created by `bunx doctree-mcp-init`).

---

### Windsurf

Add `.windsurf/mcp.json` to your project root:

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bunx",
      "args": ["doctree-mcp"],
      "env": {
        "DOCS_ROOT": "./docs",
        "WIKI_WRITE": "1"
      }
    }
  }
}
```

**Workflow prompts:** Use the `doc-read`, `doc-write`, and `doc-lint` MCP prompts from Cascade.

**Lint hook** — add to `.windsurf/hooks.json` (runs after all MCP calls — fast and safe):

```json
{
  "hooks": {
    "post_mcp_tool_use": [{ "command": "bunx doctree-mcp-lint" }]
  }
}
```

---

### Codex CLI

Add to `.codex/config.toml`:

```toml
[mcp_servers.doctree]
command = "bunx"
args = ["doctree-mcp"]

[mcp_servers.doctree.env]
DOCS_ROOT = "./docs"
WIKI_WRITE = "1"
```

**Workflow prompts:** Use the `doc-read`, `doc-write`, and `doc-lint` MCP prompts.

**Lint hook:** Codex hooks currently only intercept Bash tool calls. MCP tool interception is not yet supported — run `bunx doctree-mcp-lint` manually or use the `doc-lint` prompt for audits.

---

### OpenCode

Add to `opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "doctree": {
        "command": "bunx",
        "args": ["doctree-mcp"],
        "env": {
          "DOCS_ROOT": "./docs",
          "WIKI_WRITE": "1"
        }
      }
    }
  }
}
```

**Workflow prompts:** Use the `doc-read`, `doc-write`, and `doc-lint` MCP prompts.

**Lint plugin** — add `.opencode/plugins/doctree-lint.js` (created by `bunx doctree-mcp-init`):

```javascript
export const DoctreeLintPlugin = async ({ $ }) => ({
  "tool.execute.after": async (event) => {
    if (event?.tool?.name === "write_wiki_entry") {
      try { await $`bunx doctree-mcp-lint`; } catch {}
    }
  },
});
```

---

### Claude Desktop

Add to your [Claude Desktop config](https://modelcontextprotocol.io/quickstart/user):

```json
{
  "mcpServers": {
    "doctree": {
      "command": "bunx",
      "args": ["doctree-mcp"],
      "env": {
        "DOCS_ROOT": "/absolute/path/to/your/docs"
      }
    }
  }
}
```

> Claude Desktop does not support project-level hook configs. Use `bunx doctree-mcp-lint` manually or invoke the `doc-lint` MCP prompt for audits.

---

## How It Works: Retrieve · Curate · Add

### Retrieve

```
Agent: I need to understand the token refresh flow.

→ search_documents("token refresh")
  #1  auth/middleware.md § Token Refresh Flow       score: 12.4
  #2  auth/oauth.md § Refresh Token Lifecycle       score: 8.7

→ get_tree("docs:auth:middleware")
  [n1] # Auth Middleware (450 words)
    [n4] ## Token Refresh Flow (180 words)
      [n5] ### Automatic Refresh (90 words)

→ navigate_tree("docs:auth:middleware", "n4")
  Returns n4 + n5 — the full section and all subsections.
```

**5 retrieval tools:**

| Tool | What it does |
|------|-------------|
| `list_documents` | Browse the catalog. Filter by tag or keyword. |
| `search_documents` | BM25 keyword search with facet filters and glossary expansion. |
| `get_tree` | Table of contents — headings, word counts, summaries. |
| `get_node_content` | Full text of specific sections by node ID. |
| `navigate_tree` | A section and all its descendants in one call. |

### Curate

```
→ find_similar("JWT validation middleware checks the token signature...")
  [overlap: 0.42] docs:auth:middleware — Auth Middleware
    ⚠ Consider updating this doc instead of creating a new one.
    → navigate_tree("docs:auth:middleware", "<root_node_id>") to read it

→ navigate_tree("docs:auth:middleware", "n1")   ← read existing doc
→ write_wiki_entry(path: "auth/middleware.md", ..., overwrite: true)  ← merge + update
```

### Add

```
→ draft_wiki_entry(topic: "JWT Validation", raw_content: "...")
  Suggested path:  docs/wiki/auth/jwt-validation.md
  Inferred type:   reference
  Suggested tags:  jwt, auth, middleware

→ write_wiki_entry(..., dry_run: true)   ← validate first
  Status: dry_run_ok

→ write_wiki_entry(..., dry_run: false)  ← write
  Status: written  |  Doc ID: docs:auth:jwt-validation
```

**3 write tools** (enabled with `WIKI_WRITE=1`):

| Tool | What it does |
|------|-------------|
| `find_similar` | Duplicate detection with overlap ratios and update suggestions. |
| `draft_wiki_entry` | Scaffold: suggested path, inferred frontmatter, glossary hits. |
| `write_wiki_entry` | Validated write: path containment, schema checks, duplicate guards, dry-run. |

**Safety:** path containment · frontmatter validation · duplicate detection · dry-run · overwrite protection

---

## The LLM Wiki Pattern

doctree-mcp supports using your agent as a wiki maintainer — inspired by [Andrej Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Raw Sources     │     │  The Wiki        │     │  The Schema      │
│  (immutable)     │ ──→ │  (LLM-maintained)│ ←── │  (you define)    │
│                  │     │                  │     │                  │
│  meeting notes   │     │  structured docs │     │  CLAUDE.md rules │
│  articles        │     │  runbooks        │     │  frontmatter     │
│  incident logs   │     │  how-to guides   │     │  directory layout │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

See [docs/LLM-WIKI-GUIDE.md](docs/LLM-WIKI-GUIDE.md) for the full walkthrough.

---

## Frontmatter for Better Search

```yaml
---
title: "Descriptive Title"
description: "One-line summary — boosts search ranking"
tags: [relevant, terms, here]
type: runbook            # runbook | guide | reference | tutorial | architecture | adr
category: auth           # any domain grouping
---
```

All frontmatter fields (except reserved ones) become **filter facets**:

```
search_documents("auth", filters: { "type": "runbook", "tags": ["production"] })
```

## Glossary & Query Expansion

Place `glossary.json` in your docs root:

```json
{ "CLI": ["command line interface"], "K8s": ["kubernetes"] }
```

doctree-mcp also **auto-extracts** acronym definitions — patterns like "TLS (Transport Layer Security)" are detected and added automatically.

## Multiple Collections

```json
{ "env": { "DOCS_ROOTS": "./wiki:1.0,./api-docs:0.8,./meeting-notes:0.3" } }
```

Higher-weighted collections rank higher in search results.

## Running from Source

```bash
git clone https://github.com/joesaby/doctree-mcp.git
cd doctree-mcp
bun install

DOCS_ROOT=./docs bun run serve          # stdio
DOCS_ROOT=./docs bun run serve:http     # HTTP (port 3100)
DOCS_ROOT=./docs bun run index          # CLI: inspect indexed output
```

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_ROOT` | `./docs` | Path to your markdown folder |
| `DOCS_GLOB` | `**/*.md` | File glob pattern |
| `DOCS_ROOTS` | — | Multiple weighted collections |
| `MAX_DEPTH` | `6` | Max heading depth to index |
| `SUMMARY_LENGTH` | `200` | Characters in node summaries |
| `PORT` | `3100` | HTTP server port |
| `GLOSSARY_PATH` | `$DOCS_ROOT/glossary.json` | Abbreviation glossary |
| `WIKI_WRITE` | *(unset)* | Set to `1` to enable write tools |
| `WIKI_ROOT` | `$DOCS_ROOT` | Filesystem root for wiki writes |
| `WIKI_DUPLICATE_THRESHOLD` | `0.35` | Overlap ratio for duplicate warning |

Full details: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## Performance

| Operation | Time | Token cost |
|-----------|------|------------|
| Full index (900 docs) | 2-5s | 0 |
| Incremental re-index | ~50ms | 0 |
| Search | 5-30ms | ~300-1K tokens |
| Tree outline | <1ms | ~200-800 tokens |

## Docs

- [LLM Wiki Guide](docs/LLM-WIKI-GUIDE.md) — agent-maintained knowledge base walkthrough
- [Architecture & Design](docs/DESIGN.md) — BM25 internals, tree navigation
- [Configuration](docs/CONFIGURATION.md) — env vars, frontmatter, ranking tuning
- [Competitive Analysis](docs/COMPETITIVE-ANALYSIS.md) — comparison with PageIndex, QMD, GitMCP
- [Prompts source](src/prompts.ts) — MCP prompt templates (all clients)
- [Skills: `/doc-read`](.claude/skills/doc-read/SKILL.md), [`/doc-write`](.claude/skills/doc-write/SKILL.md), [`/doc-lint`](.claude/skills/doc-lint/SKILL.md) — Claude Code slash commands

## Standing on Shoulders

- **[PageIndex](https://pageindex.ai)** — Hierarchical tree navigation
- **[Pagefind](https://pagefind.app)** by **[CloudCannon](https://cloudcannon.com)** — BM25 scoring, positional index, filter facets
- **[Bun.markdown](https://bun.sh)** by **[Oven](https://oven.sh)** — Native CommonMark parser
- **[Andrej Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — The LLM-maintained wiki pattern

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README with dual entry points and per-tool setup guide"
```

---

## Task 14: LLM-WIKI-GUIDE refresh

**Files:**
- Modify: `docs/LLM-WIKI-GUIDE.md`

Note: Also add a new `/doc-lint` skill at `.claude/skills/doc-lint/SKILL.md` referenced in the README.

- [ ] **Step 1: Rewrite `docs/LLM-WIKI-GUIDE.md`**

Replace the entire content with:

```markdown
# LLM Wiki Guide

How to use doctree-mcp as an LLM-maintained wiki — a persistent knowledge base where your AI agent handles the bookkeeping while you curate the sources.

This implements the three-layer architecture from [Andrej Karpathy's LLM wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):

```
┌─────────────────────────────────────┐
│  Layer 3: Schema (human-configured) │  ← CLAUDE.md, wiki conventions
├─────────────────────────────────────┤
│  Layer 2: Wiki (LLM-maintained)     │  ← docs/wiki/ markdown files
├─────────────────────────────────────┤
│  Layer 1: Raw sources (immutable)   │  ← docs/raw-sources/ articles, notes
└─────────────────────────────────────┘
```

---

## Step 1: Initialize

Run in your project root:

```bash
bunx doctree-mcp-init
```

This creates the three-layer structure and configures your AI tool:

```
docs/
├── wiki/                 ← LLM-maintained (weight 1.0 in search)
│   └── getting-started.md
└── raw-sources/          ← your inputs, never written by the agent (weight 0.3)
```

It also writes your MCP config, lint hook, and wiki conventions to `CLAUDE.md` (or equivalent for your tool). See the [README setup section](../README.md#setup-by-ai-tool) if you need to configure a tool manually.

---

## Step 2: Ingest raw sources

Drop any file into `docs/raw-sources/` — an article, meeting notes, an incident report, anything. Then ask your agent:

> "Read `docs/raw-sources/[filename]` and create a wiki entry from it."

Your agent will:

```
1. search_documents("topic keywords")
   → Check if similar content already exists

2. find_similar(content)
   → Duplicate check with overlap ratios

3. draft_wiki_entry(topic, raw_content)
   → Suggested path, inferred frontmatter, glossary hits

4. write_wiki_entry(path, frontmatter, content, dry_run: true)
   → Validate first

5. write_wiki_entry(path, frontmatter, content, dry_run: false)
   → Write. New doc is immediately searchable.
```

The agent never touches `docs/raw-sources/` — those files stay immutable as your source of truth.

---

## Step 3: Update existing docs

When your agent calls `find_similar` and finds overlap > 0.35, the correct action is to **update the existing doc**, not create a new one. Here is the full update workflow:

```
1. find_similar(new_content)
   → Returns: [overlap: 0.42] docs:auth:middleware — Auth Middleware
   → ⚠ Consider updating this doc

2. navigate_tree("docs:auth:middleware", root_node_id)
   → Read the full existing document

3. Compose merged content
   → Keep existing sections that don't overlap
   → Replace or expand sections that do overlap
   → Add new sections for genuinely new information

4. write_wiki_entry(
     path: "auth/middleware.md",   ← same path as existing file
     frontmatter: { ... },         ← keep existing, update tags if needed
     content: merged_content,
     overwrite: true               ← required for updates
   )
```

**When to create new vs. update:**
- Same topic, new information → update
- Different topic that happens to share terms → create new (use `allow_duplicate: true` if blocked)
- Significant scope expansion → consider splitting into two docs

---

## Step 4: Lint and maintain

After every `write_wiki_entry` call, the lint hook runs automatically:

```
doctree-mcp lint: 2 issues found

MISSING FRONTMATTER (1):
  auth/tokens.md — missing: description, tags

ORPHANED PAGES (1):
  guides/advanced-config.md — no other docs link here
```

The agent sees this output and can fix issues inline.

For a full wiki audit, use the `doc-lint` MCP prompt (or `/doc-lint` in Claude Code):

> "Audit the wiki for health issues."

The `doc-lint` prompt guides the agent through: orphan detection → stub detection → frontmatter completeness → suggested fixes.

Run the linter manually at any time:

```bash
WIKI_ROOT=./docs/wiki bunx doctree-mcp-lint
```

---

## Step 5: Multi-collection search

By default, `bunx doctree-mcp-init` configures two collections with different weights:

```
DOCS_ROOTS=./docs/wiki:1.0,./docs/raw-sources:0.3
```

- **wiki** at weight 1.0 — authoritative, curated content ranks highest
- **raw-sources** at weight 0.3 — background context, useful for finding the original source

Add more collections as needed:

```json
"DOCS_ROOTS": "./docs/wiki:1.0,./docs/raw-sources:0.3,./meeting-notes:0.1"
```

Lower-weighted collections are still searchable but won't outrank wiki entries.

---

## Frontmatter best practices

For best search quality:

```yaml
---
title: "Descriptive Title"
description: "One-line summary for search ranking"
tags: [relevant, terms, here]
type: guide        # runbook | guide | reference | tutorial | architecture
category: auth     # any domain-specific grouping
---
```

When frontmatter is missing, doctree-mcp infers what it can:
- **title**: Falls back to first H1, then filename
- **description**: Falls back to first paragraph (200 chars)
- **type**: Auto-inferred from directory name (`runbooks/` → `runbook`)
- **Glossary**: Patterns like "TLS (Transport Layer Security)" are auto-extracted

---

## Example prompts

**Ingest a source:**
> "Read `docs/raw-sources/q1-incident-report.md` and create a runbook page documenting the remediation steps. Cross-reference any existing related runbooks."

**Query the wiki:**
> "What's our authentication flow? Show me the relevant architecture docs."

**Update from new source:**
> "Read `docs/raw-sources/updated-auth-spec.md` and update the wiki to reflect any changes. Check for existing auth docs first."

**Maintenance:**
> "Audit the wiki — find any pages that reference deprecated APIs and suggest updates."
```

- [ ] **Step 2: Create the `/doc-lint` Claude Code skill**

Create `.claude/skills/doc-lint/SKILL.md`:

```markdown
---
name: doc-lint
description: Audit the doctree-mcp wiki for orphaned pages, stubs, missing frontmatter, and broken links.
---

# Audit Wiki Health

Perform a health check on the doctree-mcp wiki using the available tools.

## Workflow

### Step 1: Find orphaned pages

```
list_documents()
```

Look for documents where the `links to:` field is absent or empty — these have no inbound cross-references from other docs.

### Step 2: Find stubs

In the `list_documents` results, identify documents with very low word counts (under ~100 words). Call `get_tree` on each to confirm they are sparse rather than just compact.

### Step 3: Check frontmatter

For each flagged doc, call `get_node_content(doc_id, [root_node_id])`. Check whether frontmatter includes: `title`, `description`, `tags`, `type`, `category`.

### Step 4: Report and fix

For each issue found, report to the user:

**Orphaned pages:** Suggest adding a cross-reference link from a related doc.
**Stubs:** Suggest either expanding the content or merging it into a related doc.
**Missing frontmatter:** Suggest the missing fields based on the content you read.

Ask the user whether to fix each issue now, or skip.

## Tips

- Run `bunx doctree-mcp-lint` in the terminal for a quick machine-readable summary
- Use `find_similar` if you want to check whether a stub should be merged into another doc
- Cross-references are markdown links — adding `[Auth Guide](../auth/guide.md)` to a doc removes its orphan status
```

- [ ] **Step 3: Commit**

```bash
git add docs/LLM-WIKI-GUIDE.md .claude/skills/doc-lint/SKILL.md
git commit -m "docs: refresh LLM-WIKI-GUIDE with init/update/lint workflow and add doc-lint skill"
```

---

## Final: Run full test suite and verify

- [ ] **Step 1: Run all tests**

```bash
bun test
```
Expected: All passing. Note the test count — should be higher than before (128+ existing + new cli-init + cli-lint + tools-format tests).

- [ ] **Step 2: Smoke test init CLI**

```bash
cd /tmp && mkdir doctree-smoke && cd doctree-smoke
node /path/to/doctree-mcp/bin-init.ts --all --dry-run
```
Expected: Prints list of files that would be created. No errors.

- [ ] **Step 3: Smoke test lint CLI**

```bash
WIKI_ROOT=/path/to/doctree-mcp/docs/wiki node /path/to/doctree-mcp/bin-lint.ts
```
Expected: Either "all clear" or a formatted issue report. No errors.

- [ ] **Step 4: Final commit**

```bash
git add -A
git status  # verify nothing unexpected
git commit -m "feat: complete doctree-mcp user journey refresh

- bunx doctree-mcp-init: full Karpathy setup + per-tool MCP/hook configs
- bunx doctree-mcp-lint: wiki health check called by post-write hooks
- README: dual entry points + per-tool setup guide (6 tools)
- LLM-WIKI-GUIDE: init-first, update workflow, lint pattern
- doc-write skill: explicit update branch after find_similar
- doc-lint skill: new wiki audit skill
- tools.ts: rich text output for find_similar + draft_wiki_entry
- prompts.ts: doc-write update branch + new doc-lint prompt"
```
