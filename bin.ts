#!/usr/bin/env -S bun run
const sub = Bun.argv[2];

if (sub === "init") {
  const { main } = await import('./src/cli-init.ts');
  await main();
} else if (sub === "lint") {
  const { main } = await import('./src/cli-lint.ts');
  await main();
} else if (sub === "serve:http") {
  await import('./src/server-http.ts');
} else {
  // `doctree-mcp` or `doctree-mcp serve` → stdio MCP server
  await import('./src/server.ts');
}
