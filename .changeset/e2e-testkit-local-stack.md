---
"@chkit/clickhouse": patch
---

`@chkit/clickhouse/e2e-testkit`: `getRequiredEnv` is now `getLiveEnv`. Without `CLICKHOUSE_URL` or `CLICKHOUSE_HOST` it targets the local test stack (`http://localhost:8123`, the repository's `test/infra` Docker Compose stack) instead of throwing.
