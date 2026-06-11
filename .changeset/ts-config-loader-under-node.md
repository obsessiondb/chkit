---
"@chkit/core": patch
"chkit": patch
---

Load `.ts` config and schema files under plain Node, not only Bun. Previously every database command (`status`, `generate`, `migrate`, `check`, `drift`, `query`) failed on Node with `Unknown file extension ".ts"`, despite the docs advertising Node.js 20+. Config and schema modules now load through jiti on Node (and continue to use Bun's native importer under Bun). Also improves the cold-start error when a config can't resolve its dependencies: instead of a raw module-resolution error, chkit now reports which package is missing and tells you to run `bun install` (or `npm`/`pnpm install`).
