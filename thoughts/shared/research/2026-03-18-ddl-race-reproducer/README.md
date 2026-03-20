# DDL Race Condition Reproducer

Reproduces the distributed ClickHouse DDL propagation race condition where a `CREATE MATERIALIZED VIEW` fails because the target table created moments before hasn't propagated to the node handling the MV statement.

## Prerequisites

- A distributed ClickHouse setup with multiple nodes behind a proxy/load balancer
- `bun` installed

## Run

```bash
# From the chkit repo root, on main branch (without the DDL wait fix)
git checkout main
bun run thoughts/shared/research/2026-03-18-ddl-race-reproducer/repro.ts
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLICKHOUSE_HOST` | `customer-benchmark.eu-central.obsessiondb.com` | ClickHouse host |
| `CLICKHOUSE_PASSWORD` | — | ClickHouse password |
| `CLICKHOUSE_DB` | `default` | Target database |
| `ATTEMPTS` | `20` | Number of create/drop cycles |

Example with custom env:

```bash
CLICKHOUSE_HOST=my-cluster.example.com CLICKHOUSE_PASSWORD=secret ATTEMPTS=50 \
  bun run thoughts/shared/research/2026-03-18-ddl-race-reproducer/repro.ts
```

## What it does

For each attempt:

1. Creates a table (`_ddl_race_events_*`)
2. Creates a SummingMergeTree target table (`_ddl_race_counts_*`)
3. Immediately creates a materialized view referencing both — no wait between statements
4. Cleans up all three objects

## Expected output

On a single-node setup: 0 failures.

On a distributed setup without session affinity: some percentage of failures with errors like:

```
Table default._ddl_race_counts_... does not exist
```

## Observed results (2026-03-18)

Against `customer-benchmark.eu-central.obsessiondb.com`:

```
Results: 18 succeeded, 2 failed out of 20
```

10% failure rate. The `session_id` is set on the ClickHouse client but does not provide node affinity — the proxy routes each HTTP request independently.

## Related

- Research: `thoughts/shared/research/2026-03-18-ddl-session-affinity-distributed-clickhouse.md`
- Fix PR: https://github.com/obsessiondb/chkit/pull/86 (client-side polling workaround)
