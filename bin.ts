#!/usr/bin/env -S bun run
const sub = Bun.argv[2];

if (sub === "init") {
  const { main } = await import('./src/cli-init.ts');
  await main();
} else if (sub === "lint") {
  const { main } = await import('./src/cli-lint.ts');
  await main();
} else {
  await import('./src/server.ts');
}
