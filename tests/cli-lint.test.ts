import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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

import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
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
