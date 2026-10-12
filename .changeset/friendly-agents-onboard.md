---
"chkit": patch
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
---

Make init and built-in command help nonmutating and independent of project configuration, accept global options before the command, typecheck plugin registration and omitted input primary keys, and retain effective primary keys when introspecting tables with implicit keys.

Scaffold offline generation without an invented connection target; require explicit credentials for a direct connection. Avoid unsupported replica synchronization queries for a known non-replicated migration journal.

Use `--help-plugins` to load configured plugin help without initialization hooks. Preserve an explicitly configured connection target and cluster during offline generation and snapshot rebuilding.

Add a TypeScript-first README, explicit credential handling for agents, a complete existing-database adoption walkthrough, and a validated data-preserving structural migration/rollback recipe. Align backfill documentation with the current partition/sort-key planner.
