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
