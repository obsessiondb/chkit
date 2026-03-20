---
date: 2026-03-18
researcher: Alvaro + Claude
git_commit: 036cc7d
branch: alvaro/num-6759-obsession-sharedmergetree-migration-race-condition
repository: chkit
topic: "DDL session affinity on distributed ClickHouse — why session_id doesn't prevent race conditions"
tags: [research, infra, proxy, session-affinity, ddl-propagation, distributed, clickhouse]
status: open
last_updated: 2026-03-18
last_updated_by: Claude
---

# Research: DDL Session Affinity on Distributed ClickHouse

**Date**: 2026-03-18
**Context**: NUM-6759 — SharedMergeTree migration race condition
**Status**: Open — needs infra-side investigation

## Problem Statement

chkit's ClickHouse executor sets `session_id: crypto.randomUUID()` on every connection (`packages/clickhouse/src/index.ts:168`). Despite this, DDL race conditions still occur in distributed setups: a `CREATE TABLE` succeeds on node A, but the immediately following `CREATE MATERIALIZED VIEW` is routed to node B where the table hasn't propagated yet.

**Core question**: Why doesn't `session_id` prevent this? And what would?

## Finding: `session_id` Does NOT Provide Node Affinity

### What session_id actually does

ClickHouse's `session_id` is a **server-side session state mechanism**, not a routing directive. It is:

- Sent as a URL query parameter (`?session_id=<uuid>`) on every HTTP request
- Used by ClickHouse server for: temporary tables, session-level settings persistence
- **Not** used by any proxy or load balancer for sticky routing

The `@clickhouse/client` SDK transmits it per-request through `toSearchParams()` (`node_modules/@clickhouse/client-common/dist/utils/url.js:47-49`). Each HTTP request is independent — the SDK does not maintain persistent connections that would inherently stick to a node.

### How it flows in chkit

1. `createClickHouseExecutor()` creates one `@clickhouse/client` instance with `session_id: crypto.randomUUID()`
2. `withClickHouseExecutor()` wraps the entire migrate command in a single executor scope
3. All DDL statements and polling queries share the same `session_id`
4. But every `db.execute()` and `db.query()` is an independent HTTP POST — the proxy routes each one independently

### Evidence it doesn't work

The race condition was observed in production despite `session_id` being set since the executor was first written. The `session_id` value is identical across all requests in a migration run, yet DDL propagation failures occur.

## Current Client-Side Mitigation (PR #86)

PR #86 adds `waitForDDLPropagation()` — polling `system.tables`/`system.columns` after each DDL statement. This is a probabilistic improvement:

- **Works in practice**: propagation is typically <1s, and the poll adds enough delay
- **Not a guarantee**: the poll itself can hit a node where the DDL has propagated, while the next DDL lands on a lagging node
- **Failure ratio scales with cluster size**: more nodes = higher chance of hitting a lagging one

## What the Journal Store Does Differently

The journal store (`packages/cli/src/bin/journal-store.ts`) already handles consistency for its own table using three mechanisms that user DDL does not:

| Mechanism | Journal Store | Migration DDL |
|-----------|:---:|:---:|
| Polling after CREATE | Yes (lines 67-74) | Yes (PR #86) |
| `SYSTEM SYNC REPLICA` | Yes (lines 82, 116) | No |
| `select_sequential_consistency = 1` | Yes (line 87) | No |
| INSERT retry with backoff | Yes (lines 104-114) | No |

`SYSTEM SYNC REPLICA` and `select_sequential_consistency` are stronger guarantees but they're replica-level, not cluster-wide DDL propagation guarantees.

## Options for a Deterministic Solution

### Option A: Proxy-Level Session Sticky Routing

**Where**: Load balancer / proxy sitting in front of ClickHouse nodes
**Mechanism**: Route all HTTP requests with the same `session_id` (or a custom header like `X-ClickHouse-Sticky`) to the same backend node
**Pros**: Zero client-side changes needed beyond what exists, zero latency overhead, 100% reliable for same-session DDL
**Cons**: Requires proxy support, may affect load distribution, doesn't help if the proxy is a ClickHouse-native component without this feature

This is the cleanest solution. If all DDL in a migration hits the same node, that node sees its own writes immediately. No propagation delay, no polling.

**Questions for infra team**:
- What proxy/load balancer sits in front of ClickHouse nodes?
- Does it support sticky sessions by query parameter or header?
- Can it be configured to route by `session_id`?
- Are there concerns about hot-spotting a single node during migrations?

### Option B: `SYSTEM SYNC DATABASE REPLICA <db>`

**Where**: Client-side, after each DDL statement
**Mechanism**: Forces the current node to sync its metadata view from Keeper/ZooKeeper
**Pros**: Deterministic — after this command, the node has current metadata
**Cons**: Only syncs the node that receives the command. If the next DDL is routed to a different node, the problem remains. Needs to be combined with Option A to be effective.

### Option C: `ON CLUSTER` DDL

**Where**: Generated SQL
**Mechanism**: DDL is distributed through Keeper and executed on all nodes, with `distributed_ddl_task_timeout` controlling how long to wait
**Pros**: ClickHouse's native solution for distributed DDL
**Cons**: Requires cluster name configuration, changes SQL generation, may not apply to SharedMergeTree (which doesn't use traditional replication). Currently explicitly ruled out in chkit's design.

**Questions for infra team**:
- Is `ON CLUSTER` applicable to the ObsessionDB distributed setup?
- What cluster name would be used?
- Does SharedMergeTree support `ON CLUSTER` DDL?

### Option D: Connection-Level Affinity (Persistent Connection)

**Where**: Client SDK / executor configuration
**Mechanism**: Use a persistent HTTP connection (keep-alive) that the proxy pins to a backend node for its lifetime
**Pros**: Natural affinity without special proxy config if the proxy respects connection-level routing
**Cons**: Most ClickHouse proxies and load balancers do per-request routing, not per-connection. HTTP/1.1 keep-alive doesn't guarantee same-backend routing in L7 load balancers.

**Questions for infra team**:
- Does the proxy do connection-level or request-level routing?
- Would HTTP/2 multiplexing change the routing behavior?

### Option E: Hybrid — Polling + SYSTEM SYNC DATABASE REPLICA

**Where**: Client-side (enhancement to current PR #86)
**Mechanism**: After each DDL, run `SYSTEM SYNC DATABASE REPLICA <db>` then poll. The sync command ensures whichever node receives it has up-to-date metadata. If the next DDL hits the same node (by chance or affinity), it succeeds deterministically.
**Pros**: Strictly better than polling alone, no infra changes needed
**Cons**: Still probabilistic without session affinity. The sync runs on the node that receives it, not necessarily the one that will receive the next DDL.

## Recommendation

**Short term (shipped)**: PR #86's polling approach. Works in practice, covers the common case.

**Medium term**: Option A (proxy sticky routing by `session_id`). This is the deterministic solution with zero client overhead. Needs infra team to evaluate proxy capabilities.

**Investigation needed**:
1. What proxy sits in front of ClickHouse? Does it support sticky sessions?
2. Is `SYSTEM SYNC DATABASE REPLICA` supported and effective in the current setup?
3. Is `ON CLUSTER` DDL applicable to the ObsessionDB architecture?

## Code References

- `packages/clickhouse/src/index.ts:168` — `session_id: crypto.randomUUID()`
- `packages/clickhouse/src/index.ts:169-172` — `wait_end_of_query`, `async_insert` settings
- `packages/cli/src/bin/clickhouse-resource.ts:4-14` — single executor per command scope
- `packages/cli/src/bin/journal-store.ts:67-74` — journal table DDL polling
- `packages/cli/src/bin/journal-store.ts:82,87,116` — SYSTEM SYNC REPLICA + sequential consistency
- `packages/clickhouse/src/ddl-propagation.ts` — PR #86 polling utilities
- `node_modules/@clickhouse/client-common/dist/utils/url.js:47-49` — session_id as URL param
- `node_modules/@clickhouse/client-common/dist/client.js:69` — session_id stored in client
