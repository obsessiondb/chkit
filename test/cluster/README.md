# Local ClickHouse cluster (chkit cluster-mode e2e)

A self-contained replicated ClickHouse cluster for verifying chkit's `ON CLUSTER`
support locally. **Deliberately not part of normal CI** (it would slow the pipeline);
run it on demand for cluster e2e verification.

## Topology

```
        ┌─────────┐
        │ keeper  │  ClickHouse Keeper (coordination + distributed-DDL queue)
        └────┬────┘
     ┌───────┴───────┐
┌────▼────┐     ┌────▼────┐
│  ch1    │     │  ch2    │   1 shard, 2 replicas
│ replica │◄───►│ replica │   cluster name: test_cluster
└─────────┘     └─────────┘
```

| Node | HTTP (host) | Native (host) | macros |
|------|-------------|---------------|--------|
| ch1  | `http://localhost:8123` | `localhost:9000` | shard=01, replica=ch1 |
| ch2  | `http://localhost:8124` | `localhost:9001` | shard=01, replica=ch2 |

Auth: user `default`, password `clusterpass`. Cluster name: `test_cluster`.

## Run

```bash
# from repo root
bun run cluster:up        # docker compose ... up -d  (waits for health)
bun run cluster:down      # stop + remove volumes (full reset)
bun run cluster:logs      # tail logs
bun run cluster:verify    # smoke-test: ON CLUSTER create + cross-replica replication
```

or directly:

```bash
docker compose -f test/cluster/docker-compose.yml up -d
docker compose -f test/cluster/docker-compose.yml down -v
```

## Point chkit / tests at it

```ts
clickhouse: {
  url: 'http://localhost:8123',
  username: 'default',
  password: 'clusterpass',
  cluster: 'test_cluster',   // ← enables ON CLUSTER mode
}
```

Cluster e2e tests run whenever their file is invoked (they are not in the
default test task) and hard-fail — never skip — if the cluster isn't reachable.
`CHKIT_CLUSTER_E2E_URL2` overrides the second node's endpoint (defaults to
`http://localhost:8124`).

## Multi-shard cluster

A 2-shard × 2-replica variant lives in [`2shard/`](./2shard/) (cluster
`test_cluster_2s`, ports 8133–8136). It uses per-shard replica naming, which is
the layout that exercises the journal's cluster-wide-unique replica id
(`{shard}_{replica}`). It coexists with this 1-shard cluster.

```bash
bun run cluster:2shard:up      # 4 ClickHouse nodes + Keeper
bun run test:cluster:2shard    # multi-shard journal e2e
bun run cluster:2shard:down
```
