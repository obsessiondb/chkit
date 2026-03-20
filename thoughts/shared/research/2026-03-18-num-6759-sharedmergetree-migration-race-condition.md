---
date: 2026-03-18T11:01:43+01:00
researcher: Alvaro gg
git_commit: bc78320e3ad4637e895a6c36fb847d1fbb7da2bc
branch: alvaro/num-6759-obsession-sharedmergetree-migration-race-condition
repository: chkit
topic: "SharedMergeTree migration race condition — DDL propagation gap between statements"
tags: [research, codebase, migrate, ddl-propagation, sharedmergetree, clickhouse-cloud, race-condition]
status: complete
last_updated: 2026-03-18
last_updated_by: Alvaro gg
---

# Research: SharedMergeTree Migration Race Condition

**Date**: 2026-03-18T11:01:43 CET
**Researcher**: Alvaro gg
**Git Commit**: bc78320e3ad4637e895a6c36fb847d1fbb7da2bc
**Branch**: alvaro/num-6759-obsession-sharedmergetree-migration-race-condition
**Repository**: chkit

## Research Question

NUM-6759: CREATE TABLE on one node, MV hits another node before DDL propagates. Migrations appear done but schema is inconsistent. Need to ensure DDL propagation completes across all nodes before proceeding with dependent operations.

## Summary

The migration execution loop in `packages/cli/src/bin/commands/migrate.ts:289-291` executes SQL statements sequentially with no inter-statement DDL propagation wait. On ClickHouse Cloud (SharedMergeTree), a `CREATE TABLE` acknowledged on one node may not yet be visible on other nodes when the next statement (e.g., `CREATE MATERIALIZED VIEW` referencing that table) executes. The codebase already has DDL propagation awareness in two places — the journal store and the e2e test kit — but not in the migration execution path itself.

## Detailed Findings

### 1. Migration Execution Loop (The Gap)

**File**: `packages/cli/src/bin/commands/migrate.ts:289-291`

The core execution loop is:

```typescript
for (const statement of statements) {
  await db.execute(statement)
}
```

Each statement awaits the ClickHouse server response before proceeding. The client uses `wait_end_of_query: 1` (`packages/clickhouse/src/index.ts:170`), so the server fully processes each query before responding. However, on ClickHouse Cloud with SharedMergeTree, the acknowledgment means the DDL succeeded **on the receiving node** — it does not guarantee propagation to all nodes. The next statement may be routed to a different node where the previous DDL has not yet propagated.

### 2. Operation Ordering (Tables Before MVs)

**File**: `packages/core/src/planner.ts:424-436`

The planner sorts operations by rank:

| Rank | Operations |
|------|-----------|
| 0 | `drop_*` |
| 1 | `alter_*` |
| 2 | `create_database` |
| 3 | `create_table` |
| 4 | `create_view` |
| 5 | `create_materialized_view` (and default) |

This ordering is correct — tables are always created before views/MVs that reference them. The problem is not ordering; it's the lack of a propagation wait between rank transitions.

### 3. Existing DDL Propagation Awareness (Journal Store)

**File**: `packages/cli/src/bin/journal-store.ts:50-76`

The journal store already handles DDL propagation for its own table:

- After `CREATE TABLE`, polls up to 10 times at 250ms intervals to confirm the table is queryable (`ensureTable()`, lines 67-74).
- Uses `SYSTEM SYNC REPLICA` before reads and after writes (lines 82, 116).
- Uses `select_sequential_consistency = 1` for linearizable reads (line 87).
- Has retry logic for SharedMergeTree INSERT race conditions with linear backoff (lines 104-114).

Comments explicitly reference ClickHouse Cloud DDL propagation lag.

### 4. Existing Polling Utilities (E2E Test Kit)

**File**: `packages/clickhouse/src/e2e-testkit.ts:87-152`

Three polling utilities exist but are only used in tests:

- `waitForTable(executor, database, tableName, { timeoutMs = 15_000, intervalMs = 500 })` — polls `system.tables`
- `waitForView(executor, database, viewName, { timeoutMs = 15_000, intervalMs = 500 })` — polls `system.tables`
- `waitForColumn(executor, database, tableName, columnName, { timeoutMs = 15_000, intervalMs = 500 })` — polls `system.columns`

These are re-exported from `packages/cli/src/e2e-testkit.ts` and used in:
- `packages/cli/src/clickhouse-live.e2e.test.ts:263-264` (waitForTable after migrate)
- `packages/cli/src/drift.e2e.test.ts:89-96` (waitForTable + waitForColumn after ALTER)

### 5. ClickHouse Client Configuration

**File**: `packages/clickhouse/src/index.ts:162-173`

The client is configured with:
- `session_id: crypto.randomUUID()` — unique session per executor
- `wait_end_of_query: 1` — server waits for query completion
- `async_insert: 0` — disables async inserts

### 6. DROP SYNC for Materialized Views

**File**: `packages/core/src/planner.ts:54-59`

Materialized view drops use the `SYNC` keyword: `DROP TABLE IF EXISTS db.name SYNC;`. Regular tables and views do not use `SYNC` in their DROP statements.

### 7. SharedMergeTree Engine Normalization

**File**: `packages/core/src/sql-normalizer.ts:5-11`

`normalizeEngine()` strips the `Shared` prefix when comparing engines, treating `SharedMergeTree` and `MergeTree` as equivalent for diff/drift purposes.

### 8. Plugin Hook Points

**File**: `packages/cli/src/bin/commands/migrate.ts:280-308`

The migrate command has plugin hooks around execution:
- `onBeforeApply(statements, migrationName)` — can modify the statement list
- `onAfterApply(migrationName)` — post-apply callback

These could theoretically be used by a plugin to inject waits, but no existing plugin does so.

## Code References

- `packages/cli/src/bin/commands/migrate.ts:289-291` — Migration execution loop (no inter-step DDL wait)
- `packages/core/src/planner.ts:424-436` — Operation ranking/ordering
- `packages/cli/src/bin/journal-store.ts:50-76` — DDL propagation wait for journal table
- `packages/cli/src/bin/journal-store.ts:79-97` — SYSTEM SYNC REPLICA + sequential consistency reads
- `packages/cli/src/bin/journal-store.ts:99-120` — INSERT race retry logic
- `packages/clickhouse/src/e2e-testkit.ts:87-152` — waitForTable/waitForView/waitForColumn (test-only)
- `packages/clickhouse/src/index.ts:162-173` — Client settings (wait_end_of_query, async_insert)
- `packages/core/src/planner.ts:54-59` — DROP ... SYNC for materialized views
- `packages/core/src/sql-normalizer.ts:5-11` — SharedMergeTree engine normalization
- `packages/codegen/src/index.ts:37-66` — Migration file format with operation metadata
- `packages/cli/src/bin/safety-markers.ts:112-119` — Statement extraction from migration files

## Architecture Documentation

### Migration Data Flow

1. `generate` → `planDiff()` diffs schema against snapshot → `generateArtifacts()` writes `.sql` + `snapshot.json`
2. `.sql` files contain `-- operation:` comment metadata with type, key, and risk
3. `migrate` → reads `.sql` files → compares against journal → executes pending statements → records in journal

### Existing Sync Patterns

The codebase uses three patterns for ClickHouse Cloud eventual consistency:

1. **Polling system tables** (`waitForTable/View/Column`) — deadline-based, configurable timeout/interval
2. **SYSTEM SYNC REPLICA + sequential consistency** — used for journal reads/writes
3. **Retry with backoff** — used for INSERT race conditions (linear backoff: `attempt * 150ms`)

### What Does NOT Exist

- No `ON CLUSTER` clauses in generated SQL
- No queries against `system.replicas`, `system.clusters`, `system.replication_queue`
- No `SYSTEM FLUSH` commands
- No DDL wait between migration statements in production code
- No dependency graph for operations (ordering is type-rank only)
