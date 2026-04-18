# Operation Modes

doctree-mcp runs in three modes. Pick based on where the agent lives and who needs access.

| Mode | Transport | Use when | Guide |
|---|---|---|---|
| **stdio** (default) | Local subprocess | Single developer, agent runs on your machine | [Client setup](./CLIENTS.md) |
| **HTTP** | Streamable HTTP | Team/shared/remote agents, CI, web clients | [Deployment](./DEPLOY.md) |
| **CLI** | Shell invocation | Setup, linting, debugging (no agent) | [CLI commands](#cli-mode) below |

---

## stdio mode (local)

The MCP client (Claude Code, Cursor, Windsurf, Codex, OpenCode, Claude Desktop) spawns doctree-mcp as a subprocess and talks over stdin/stdout. Indexing happens at startup; state lives in the subprocess.

**Start manually** (you usually don't — the client launches it):

```bash
DOCS_ROOT=./docs bun run serve
```

**Configure your AI tool:** see [Client setup](./CLIENTS.md) for copy-paste configs for each supported client.

**When to choose:** one user, local docs, no network needed.

---

## HTTP mode (remote/shared)

A long-running process exposes `/mcp` (Streamable HTTP) + `/health`. Multiple clients connect to one index; indexing happens once at boot.

**Start manually:**

```bash
DOCS_ROOT=./docs bun run serve:http
# → http://localhost:3100/mcp
# → http://localhost:3100/health
```

**Test locally:**

```bash
curl http://localhost:3100/health
# {"status":"ok","document_count":42,"total_nodes":210}
```

**Deploy to a platform** — see [Deployment guide](./DEPLOY.md):

- [Railway](./DEPLOY.md#railway) — Nixpacks, one-click from GitHub
- [Fly.io](./DEPLOY.md#flyio) — global edges, ships with `fly.toml`
- [Render](./DEPLOY.md#render) — Dockerfile-based
- [Cloudflare Containers](./DEPLOY.md#cloudflare-containers) — serverless containers (Workers won't work — Bun runtime required)
- [Docker anywhere](./DEPLOY.md#docker-anywhere) — ECS, GKE, Nomad, bare metal

**Transport note:** the server is stateless Streamable HTTP, so any MCP client supporting remote transports can connect — including Claude Desktop via `mcp-remote`.

**When to choose:** team shares one corpus · agent runs in CI or a hosted service · docs live on a server, not your laptop.

---

## CLI mode

Utility commands that don't start a server:

```bash
bunx doctree-mcp init           # scaffold a wiki + configure AI tool(s)
bunx doctree-mcp lint           # audit orphans, stubs, broken links, missing frontmatter
DOCS_ROOT=./docs bun run index  # debug: inspect the indexed output (tree + facets)
```

- `init` accepts `--claude-code`, `--cursor`, `--windsurf`, `--codex`, `--opencode`, or `--all`. See [LLM Wiki Guide](./LLM-WIKI-GUIDE.md).
- `lint` is what the post-write hook fires. It also runs standalone for CI checks.
- `bun run index` is for debugging the indexer — it prints the tree that the MCP server would expose.

---

## Picking a mode

| If… | Use |
|---|---|
| Just you on a laptop | stdio |
| Team members share one docs repo | HTTP, hosted |
| CI or a deployed agent needs docs | HTTP, hosted |
| Claude Desktop against a remote corpus | HTTP + `mcp-remote` |
| Setting up or auditing a wiki | CLI |

Env vars apply to all modes — see [CONFIGURATION.md](./CONFIGURATION.md).
