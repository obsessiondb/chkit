---
"@chkit/cli": patch
"@chkit/clickhouse": patch
"@chkit/codegen": patch
"@chkit/core": patch
"@chkit/plugin-backfill": patch
"@chkit/plugin-pull": patch
"@chkit/plugin-codegen": patch
---

Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
