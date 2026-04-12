#!/usr/bin/env -S bun run
import { main } from './src/cli-lint.ts'
main().catch(console.error)
