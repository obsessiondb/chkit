---
"@chkit/clickhouse": patch
---

Fix the `@chkit/clickhouse/e2e-testkit` subpath export. Both conditions pointed at `./src/e2e-testkit.ts`, which `files: ["dist"]` excludes from the published tarball, so importing the subpath from the published package hit a hard module-not-found. Build it to `dist` and point the export there (keeping a `source` condition for in-repo type resolution).
