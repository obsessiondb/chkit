# Kafka engine integration test

The private workspace `@chkit/kafka-e2e` runs the real CLI against the Redpanda
broker and ClickHouse in the local test stack (`test/infra`). It is part of
`bun run test` and CI's **verify** job; Turbo starts the stack first. It is left
out of `bun run test:obsessiondb`, because a managed ClickHouse cannot reach the
local broker.

```sh
bun run test --filter=@chkit/kafka-e2e
```

The test creates unique topics/databases and cleans up only its own fixtures.
It verifies SQL migration execution, Kafka → MV → MergeTree ingestion, escaped
setting literals, pull/generate round trips, clean drift/check, settings drift,
rejection of unsupported changes without advancing snapshots, and an explicit
drop/create replacement with the existing destructive-operation gate.
