# Client Setup

Per-client configuration for stdio mode. All clients use the same MCP server — just replace `./docs` with your actual docs path.

For remote/hosted setups see the [Deployment guide](./DEPLOY.md). For a mode overview see [Operation Modes](./OPERATION-MODES.md).

> **One-shot setup:** `bunx doctree-mcp init` writes the right config for your tool, plus hooks and wiki conventions. The snippets below are what it would produce — use them if you prefer to configure manually.

---

## Claude Code

`.mcp.json` in your project root:

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

**Workflow prompts:** `/doc-read`, `/doc-write`, `/doc-lint` slash commands.

**Lint hook** — add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "write_wiki_entry",
        "hooks": [{ "type": "command", "command": "bunx doctree-mcp lint" }]
      }
    ]
  }
}
```

---

## Cursor

`.cursor/mcp.json`:

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

**Workflow prompts:** `doc-read`, `doc-write`, `doc-lint` from the chat panel.

**Lint hook** — `.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "afterMCPExecution": [{ "command": "bunx doctree-mcp lint" }]
  }
}
```

**Rules** — commit `.cursor/rules/doctree-wiki.mdc` (created by `bunx doctree-mcp init`).

---

## Windsurf

`.windsurf/mcp.json`:

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

**Workflow prompts:** `doc-read`, `doc-write`, `doc-lint` from Cascade.

**Lint hook** — `.windsurf/hooks.json`:

```json
{
  "hooks": {
    "post_mcp_tool_use": [{ "command": "bunx doctree-mcp lint" }]
  }
}
```

---

## Codex CLI

`.codex/config.toml`:

```toml
[mcp_servers.doctree]
command = "bunx"
args = ["doctree-mcp"]

[mcp_servers.doctree.env]
DOCS_ROOT = "./docs"
WIKI_WRITE = "1"
```

**Workflow prompts:** `doc-read`, `doc-write`, `doc-lint` MCP prompts.

**Lint hook:** Codex hooks only intercept Bash today. Run `bunx doctree-mcp lint` manually or use the `doc-lint` prompt for audits.

---

## OpenCode

`opencode.json`:

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

**Lint plugin** — `.opencode/plugins/doctree-lint.js`:

```javascript
export const DoctreeLintPlugin = async ({ $ }) => ({
  "tool.execute.after": async (event) => {
    if (event?.tool?.name === "write_wiki_entry") {
      try { await $`bunx doctree-mcp lint`; } catch {}
    }
  },
});
```

---

## Claude Desktop

[Claude Desktop config](https://modelcontextprotocol.io/quickstart/user):

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

> Claude Desktop doesn't support project-level hooks. Use `bunx doctree-mcp lint` manually or invoke the `doc-lint` MCP prompt.

**Pointing Desktop at a remote server?** See [Deployment guide: connecting Claude Desktop via `mcp-remote`](./DEPLOY.md#claude-desktop-via-mcp-remote).

---

## Multi-instance routing

Register several doctree servers under different names and let the `/doc-read` skill route between them:

```json
{
  "mcpServers": {
    "wiki":    { "command": "bunx", "args": ["doctree-mcp"], "env": { "DOCS_ROOT": "./wiki" } },
    "api":     { "command": "bunx", "args": ["doctree-mcp"], "env": { "DOCS_ROOT": "./api-docs" } },
    "tickets": { "command": "bunx", "args": ["doctree-mcp"], "env": { "DOCS_GLOB": "**/*.csv", "DOCS_ROOT": "./tickets" } }
  }
}
```

See the [skill + MCP pattern](../README.md#the-skill--mcp-pattern) in the README for why client-side federation via skills beats server-side fan-out.
