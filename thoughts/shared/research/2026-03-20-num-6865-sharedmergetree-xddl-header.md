---
date: 2026-03-20T10:35:08+01:00
researcher: Alvaro + Claude
git_commit: 638f75f35eb4fae894b4343f522f3ca3d0b6cd3b
branch: alvaro/num-6865-obsession-sharedmergetree-migration-race-condition-fix-v2
repository: chkit
topic: "X-DDL header for SharedMergeTree node pinning during migrations"
tags: [research, clickhouse, ddl, sharedmergetree, node-pinning, http-headers]
status: complete
last_updated: 2026-03-20
last_updated_by: Claude
---

# Research: X-DDL Header for SharedMergeTree Node Pinning

**Date**: 2026-03-20T10:35:08 CET
**Researcher**: Alvaro + Claude
**Git Commit**: 638f75f
**Branch**: alvaro/num-6865-obsession-sharedmergetree-migration-race-condition-fix-v2
**Repository**: chkit

## Research Question

Ticket NUM-6865 asks to add the `X-DDL: 1` HTTP header (created by Marc on the proxy/infra side) to ClickHouse requests during migrations. This header pins requests to a single node so that sequential DDL operations all hit the same ClickHouse server, eliminating the SharedMergeTree race condition where DDL propagation hasn't completed before the next statement arrives on a different node.

## Summary

The implementation is straightforward. The `@clickhouse/client` SDK supports `http_headers` at both client-level and per-request level. The single place to change is `createClickHouseExecutor()` in `packages/clickhouse/src/index.ts:170-181`, which is the factory for all ClickHouse connections. Adding `http_headers: { 'X-DDL': '1' }` to the `createClient()` call would send the header on every request made through that executor.

This is the "Option A" (proxy-level sticky routing) from the [prior research](./2026-03-18-ddl-session-affinity-distributed-clickhouse.md), now made possible by Marc's proxy-side implementation.

## Detailed Findings

### Current Client Creation

`packages/clickhouse/src/index.ts:170-181`:

```typescript
export function createClickHouseExecutor(config: NonNullable<ChxConfig['clickhouse']>): ClickHouseExecutor {
  const client = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    session_id: crypto.randomUUID(),
    clickhouse_settings: {
      wait_end_of_query: 1,
      async_insert: 0,
    },
  })
```

No `http_headers` are currently set.

### SDK Support for `http_headers`

The `@clickhouse/client` SDK supports headers at two levels:

1. **Client-level** (`createClient({ http_headers: { ... } })`): sent on every request
2. **Per-request** (`client.command({ query, http_headers: { ... } })`): overrides client-level for that request

Header merge order (from `node_modules/@clickhouse/client/dist/connection/node_base_connection.js:251-261`):
1. Client-level `http_headers`
2. Per-request `http_headers` (overrides same keys)
3. Connection + User-Agent (not overridable)

### All `createClickHouseExecutor` Call Sites

| Location | Context |
|----------|---------|
| `packages/cli/src/bin/clickhouse-resource.ts:8` | `withClickHouseExecutor()` — wraps migrate, status, drift, check commands |
| `packages/clickhouse/src/e2e-testkit.ts:52` | `createLiveExecutor()` — E2E tests |
| `packages/plugin-backfill/src/plugin.ts:215,283` | Backfill plugin |
| `packages/cli/src/bin/journal-store.ts:127` | Journal store (indirect via executor passed in) |

### Existing DDL Consistency Mechanisms

The current approach (PR #86) uses polling after each DDL statement via `waitForDDLPropagation()` in `packages/clickhouse/src/ddl-propagation.ts`. This is probabilistic — the poll can hit a node where DDL has propagated while the next DDL lands on a lagging node. The `X-DDL: 1` header would make this deterministic by ensuring all requests go to the same node.

### Interaction with Existing `session_id`

The executor already sets `session_id: crypto.randomUUID()` (line 176), but as documented in the [prior research](./2026-03-18-ddl-session-affinity-distributed-clickhouse.md), `session_id` is a server-side state mechanism, not a routing directive. The `X-DDL` header is the proxy-side routing solution.

## Design Considerations

### Scope of the Header

- **All requests via the executor**: If set at client-level in `createClient()`, the header goes on every request (DDL, queries, inserts). This is the simplest approach and safe — the proxy just uses it for routing, non-DDL queries benefit from hitting the same node too (e.g., the `system.tables` polls in `waitForDDLPropagation` would hit the same node that just executed the DDL).

- **DDL only**: Could use per-request headers on `client.command()` calls only. But this would require changing the `ClickHouseExecutor` interface or adding a flag. More complexity for unclear benefit.

### Whether to Keep the Polling

The `waitForDDLPropagation()` polling from PR #86 could be kept as a safety net or removed since node pinning makes it redundant. Keeping it is harmless (adds ~0ms overhead when the DDL is already visible on the same node) and provides defense-in-depth for setups without the proxy header support.

### Whether to Make the Header Configurable

The header could be hardcoded or exposed via `clickhouse.config.ts`. Hardcoding is simpler and the header is inert if the proxy doesn't recognize it.

## Code References

- `packages/clickhouse/src/index.ts:170-181` — `createClickHouseExecutor()`, the single point of change
- `packages/clickhouse/src/ddl-propagation.ts` — existing polling mechanism
- `packages/cli/src/bin/clickhouse-resource.ts:4-14` — executor lifecycle wrapper
- `node_modules/@clickhouse/client-common/dist/config.d.ts:79-82` — `http_headers` type definition
- `node_modules/@clickhouse/client/dist/connection/node_base_connection.js:251-261` — header merge logic

## Historical Context

- [2026-03-18 DDL Session Affinity Research](./2026-03-18-ddl-session-affinity-distributed-clickhouse.md) — identified proxy sticky routing (Option A) as the recommended deterministic solution
- PR #86 (commit 638f75f) — added `waitForDDLPropagation()` as a probabilistic client-side mitigation
