import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { scaffoldDirs, generateMcpConfig, generateHookConfig, generateAgentInstructions, detectTools, writeConfigFiles, type Tool } from "../src/cli-init";

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

describe("generateMcpConfig", () => {
  test("claude-code: generates .mcp.json content", () => {
    const result = generateMcpConfig("claude-code");
    const parsed = JSON.parse(result!.content);
    expect(result!.path).toBe(".mcp.json");
    expect(parsed.mcpServers.doctree.command).toBe("bunx");
    expect(parsed.mcpServers.doctree.args).toContain("doctree-mcp");
    expect(parsed.mcpServers.doctree.env.DOCS_ROOTS).toContain("docs/wiki:1.0");
    expect(parsed.mcpServers.doctree.env.WIKI_WRITE).toBe("1");
  });

  test("cursor: generates .cursor/mcp.json", () => {
    const result = generateMcpConfig("cursor");
    expect(result!.path).toBe(".cursor/mcp.json");
    const parsed = JSON.parse(result!.content);
    expect(parsed.mcpServers.doctree.env.DOCS_ROOTS).toContain("docs/wiki:1.0");
  });

  test("windsurf: generates .windsurf/mcp.json", () => {
    const result = generateMcpConfig("windsurf");
    expect(result!.path).toBe(".windsurf/mcp.json");
  });

  test("codex: generates .codex/config.toml with TOML format", () => {
    const result = generateMcpConfig("codex");
    expect(result!.path).toBe(".codex/config.toml");
    expect(result!.content).toContain("[mcp_servers.doctree]");
    expect(result!.content).toContain("DOCS_ROOTS");
    expect(result!.content).toContain("WIKI_WRITE");
  });

  test("opencode: generates opencode.json", () => {
    const result = generateMcpConfig("opencode");
    expect(result!.path).toBe("opencode.json");
    const parsed = JSON.parse(result!.content);
    expect(parsed.mcp?.servers?.doctree).toBeDefined();
  });

  test("claude-desktop: returns null (no project file)", () => {
    const result = generateMcpConfig("claude-desktop");
    expect(result).toBeNull();
  });
});

describe("generateHookConfig", () => {
  test("claude-code: PostToolUse matcher on write_wiki_entry", () => {
    const result = generateHookConfig("claude-code");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    const postHooks = parsed.hooks?.PostToolUse;
    expect(postHooks).toBeDefined();
    expect(postHooks[0].matcher).toBe("write_wiki_entry");
    expect(postHooks[0].hooks[0].command).toContain("doctree-mcp lint");
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
    expect(result!.content).toContain("doctree-mcp lint");
  });

  test("codex: PostToolUse present", () => {
    const result = generateHookConfig("codex");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.hooks?.PostToolUse).toBeDefined();
  });

  test("claude-desktop: returns null", () => {
    expect(generateHookConfig("claude-desktop")).toBeNull();
  });
});

describe("generateAgentInstructions", () => {
  test("claude-code: appends to CLAUDE.md", () => {
    const result = generateAgentInstructions("claude-code");
    expect(result!.path).toBe("CLAUDE.md");
    expect(result!.append).toBe(true);
    expect(result!.content).toContain("Wiki Conventions");
    expect(result!.content).toContain("find_similar");
    expect(result!.content).toContain("navigate_tree");
  });

  test("cursor: creates .cursor/rules/doctree-wiki.mdc with frontmatter", () => {
    const result = generateAgentInstructions("cursor");
    expect(result!.path).toBe(".cursor/rules/doctree-wiki.mdc");
    expect(result!.append).toBe(false);
    expect(result!.content).toContain("alwaysApply: false");
    expect(result!.content).toContain("Wiki Conventions");
  });

  test("windsurf: appends to CLAUDE.md", () => {
    const result = generateAgentInstructions("windsurf");
    expect(result!.path).toBe("CLAUDE.md");
    expect(result!.append).toBe(true);
  });

  test("codex: creates AGENTS.md", () => {
    const result = generateAgentInstructions("codex");
    expect(result!.path).toBe("AGENTS.md");
    expect(result!.append).toBe(false);
    expect(result!.content).toContain("Wiki Conventions");
  });

  test("opencode: returns null", () => {
    expect(generateAgentInstructions("opencode")).toBeNull();
  });

  test("claude-desktop: returns null", () => {
    expect(generateAgentInstructions("claude-desktop")).toBeNull();
  });
});

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
    const occurrences = (content.match(/Wiki Conventions \(doctree-mcp\)/g) || []).length;
    expect(occurrences).toBe(1);
  });
});
