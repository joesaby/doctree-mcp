# Deployment Guide

How to run doctree-mcp in [HTTP mode](./OPERATION-MODES.md#http-mode-remoteshared) on common platforms. All options expose:

- `POST /mcp` — Streamable HTTP MCP endpoint
- `GET /health` — `{ "status": "ok", "document_count": N, "total_nodes": N }`

The repo ships platform configs: `Dockerfile`, `railway.json`, `fly.toml`, `smithery.yaml`.

---

## Choosing a platform

| Platform | Best for | Build system | Cold start |
|---|---|---|---|
| [Railway](#railway) | Fastest setup, GitHub-connected | Nixpacks (Bun) | ~1–2s |
| [Fly.io](#flyio) | Global edges, auto-stop | Dockerfile | ~2–3s |
| [Render](#render) | Free tier, simple | Dockerfile | ~5s |
| [Cloudflare Containers](#cloudflare-containers) | Already on Cloudflare | Dockerfile | ~1–2s |
| [Docker anywhere](#docker-anywhere) | Self-hosted, ECS, GKE | Dockerfile | depends |

> **Cloudflare Workers is not supported.** doctree-mcp uses `Bun.markdown`, `Bun.hash`, `Bun.file`, and `Bun.Glob`, which aren't available in the Workers runtime. Use **Cloudflare Containers** instead.

---

## Getting your docs onto the server

The server needs `DOCS_ROOT` to point at readable markdown/CSV/JSONL. Three patterns:

1. **Bake into the image (simplest).** Commit docs to the repo; the Dockerfile copies them in. Rebuild to update.
2. **Git-clone at boot.** Add a startup step that `git clone`s a docs repo into `/app/docs`, then runs the server. Good for frequent updates.
3. **Mount a volume.** Attach persistent storage (Fly volumes, Railway volumes, Cloudflare R2-as-fs) and point `DOCS_ROOT` at the mount.

The sections below use option 1 unless otherwise noted.

---

## Railway

Config: `railway.json` (already in repo).

```json
{
  "build": { "builder": "NIXPACKS", "buildCommand": "bun install --production" },
  "deploy": {
    "startCommand": "bun run serve:http",
    "healthcheckPath": "/health"
  }
}
```

### Deploy

1. Push your fork to GitHub.
2. On railway.app: **New Project → Deploy from GitHub → select your fork**.
3. Under **Variables**, set:
   - `DOCS_ROOT` — e.g. `./docs` if docs are in-repo, or path to a mounted volume
   - `WIKI_WRITE` — `1` to enable write tools (optional)
   - `DOCS_GLOB`, `MAX_DEPTH`, etc. — see [CONFIGURATION.md](./CONFIGURATION.md)
4. Railway picks up `PORT` automatically; the server reads it via `process.env.PORT`.

### Test

```bash
curl https://<your-project>.up.railway.app/health
```

Expect `{"status":"ok",…}`. Then point an MCP client at `https://<your-project>.up.railway.app/mcp`.

---

## Fly.io

Config: `fly.toml` (already in repo).

```toml
app = "doctree-mcp"
primary_region = "iad"

[env]
  PORT = "3100"
  DOCS_ROOT = "./docs"

[http_service]
  internal_port = 3100
  force_https = true
  auto_stop_machines = "stop"
  min_machines_running = 0
```

### Deploy

```bash
fly launch --no-deploy    # pick app name, region; skip DB prompts
fly secrets set WIKI_WRITE=1 DOCS_GLOB="**/*.md,**/*.csv"
fly deploy
```

### Test

```bash
curl https://doctree-mcp.fly.dev/health
fly logs                  # watch boot + index stats
```

### Persistent docs via volume

```bash
fly volumes create docs_data --size 1
# then in fly.toml:
#   [mounts]
#     source = "docs_data"
#     destination = "/app/docs"
```

SSH in with `fly ssh console` to populate `/app/docs`, or bake a git-clone step into the Dockerfile.

---

## Render

No repo config needed — Render reads the `Dockerfile` directly.

### Deploy

1. On render.com: **New → Web Service → Build and deploy from a Git repository**.
2. Select your fork. Render auto-detects the Dockerfile.
3. **Environment:** set
   - `DOCS_ROOT=/app/docs`
   - `WIKI_WRITE=1` (optional)
   - any of [CONFIGURATION.md](./CONFIGURATION.md) vars
4. **Health Check Path:** `/health`
5. **Port:** Render injects `PORT` — the Dockerfile's `EXPOSE 3100` is just a default.

### Test

```bash
curl https://<your-service>.onrender.com/health
```

### Persistent docs

Render disks mount at a path you specify — mount at `/app/docs` and populate via the shell tab or a pre-deploy git clone.

---

## Cloudflare Containers

Cloudflare Containers run your Dockerfile as an isolated instance fronted by a Worker. This is the Cloudflare path that actually works for doctree-mcp — **not Workers**, which lacks the Bun runtime.

### Deploy

1. Install wrangler: `npm i -g wrangler`.
2. Add a `wrangler.toml`:

   ```toml
   name = "doctree-mcp"
   compatibility_date = "2025-10-01"

   [[containers]]
   name = "doctree"
   image = "./Dockerfile"
   instances = 1
   ```

3. Add a Worker entry that forwards requests to the container binding (see [Cloudflare Containers docs](https://developers.cloudflare.com/containers/)).
4. Set secrets:

   ```bash
   wrangler secret put DOCS_ROOT
   wrangler secret put WIKI_WRITE
   ```

5. `wrangler deploy`.

### Test

```bash
curl https://doctree-mcp.<your-account>.workers.dev/health
```

### Docs source

Containers are ephemeral — bake docs into the image or have the container pull from R2/KV at boot.

---

## Docker anywhere

The shipped `Dockerfile` works on any Docker runtime (ECS, GKE, Nomad, Kubernetes, bare VM, Coolify, Dokku).

### Build & run

```bash
docker build -t doctree-mcp .
docker run -d \
  -p 3100:3100 \
  -e DOCS_ROOT=/app/docs \
  -e WIKI_WRITE=1 \
  -v "$(pwd)/docs:/app/docs" \
  --name doctree-mcp \
  doctree-mcp
```

### Test

```bash
curl http://localhost:3100/health
```

### Kubernetes readiness/liveness

```yaml
readinessProbe:
  httpGet: { path: /health, port: 3100 }
  initialDelaySeconds: 5
livenessProbe:
  httpGet: { path: /health, port: 3100 }
  periodSeconds: 30
```

---

## Connecting clients to a hosted server

### Remote MCP (Claude Code, Cursor, Windsurf)

Clients supporting Streamable HTTP can connect directly:

```json
{
  "mcpServers": {
    "doctree": { "url": "https://doctree-mcp.example.com/mcp" }
  }
}
```

### Claude Desktop via `mcp-remote`

Claude Desktop only speaks stdio. Bridge with [`mcp-remote`](https://github.com/geelen/mcp-remote):

```json
{
  "mcpServers": {
    "doctree": {
      "command": "npx",
      "args": ["mcp-remote", "https://doctree-mcp.example.com/mcp"]
    }
  }
}
```

---

## Smoke test checklist

After any deploy:

```bash
# 1. Health endpoint returns ok
curl -fsS https://<host>/health | jq .
# {"status":"ok","document_count":42,"total_nodes":210}

# 2. MCP endpoint responds to an initialize request
curl -s -X POST https://<host>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

# 3. Point a real client at /mcp and run: search_documents("hello")
```

If `document_count` is `0`, `DOCS_ROOT` is wrong or the docs didn't make it into the image. See [Getting your docs onto the server](#getting-your-docs-onto-the-server).
