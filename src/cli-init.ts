/**
 * Init CLI — scaffolds a Karpathy-style LLM wiki and configures AI tools.
 *
 * Usage:
 *   bunx doctree-mcp init           # interactive tool selection
 *   bunx doctree-mcp init --all     # configure all supported tools
 *   bunx doctree-mcp init --dry-run # print actions without writing
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
      return null;
  }
}

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
                  hooks: [{ type: "command", command: "bunx doctree-mcp lint" }],
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
              afterMCPExecution: [{ command: "bunx doctree-mcp lint" }],
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
              post_mcp_tool_use: [{ command: "bunx doctree-mcp lint" }],
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
          "      try { await $`bunx doctree-mcp lint`; } catch {}",
          "    }",
          "  },",
          "});",
        ].join("\n"),
      };

    case "codex":
      // Note: Codex hooks only intercept Bash tool calls as of April 2026.
      // MCP tool interception is not yet supported. Config written for forward-compatibility.
      return {
        path: ".codex/hooks.json",
        content: JSON.stringify(
          {
            hooks: {
              PostToolUse: [
                {
                  matcher: "Bash",
                  hooks: [
                    {
                      type: "command",
                      command:
                        "# Codex MCP hooks not yet supported. Remove this comment when available.\n# bunx doctree-mcp lint",
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

interface InstructionFile {
  path: string;
  content: string;
  append: boolean;
}

export function generateAgentInstructions(tool: Tool): InstructionFile | null {
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

async function promptTools(detected: Tool[]): Promise<Tool[]> {
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

export async function main() {
  const args = Bun.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const root = process.cwd();

  console.log("doctree-mcp init");
  if (dryRun) console.log("(dry run — no files will be written)\n");

  const detected = detectTools(root);
  const tools: Tool[] = all
    ? ["claude-code", "cursor", "windsurf", "codex", "opencode"]
    : await promptTools(detected);

  const scaffolded = await scaffoldDirs(root, dryRun);
  const configured = await writeConfigFiles(tools, root, dryRun);

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
