# Kafka engine integration test

This opt-in suite runs an isolated Kafka-compatible Redpanda broker and ClickHouse.
It exercises the real CLI and actual message consumption; it fails if the services
are unavailable. It is separate from the normal test suite because managed
ClickHouse test targets do not necessarily enable the Kafka engine.

```sh
bun install --frozen-lockfile
bunx turbo run build --filter=chkit... --filter=@chkit/plugin-pull
docker compose -p chkit-issue203 -f test/kafka/docker-compose.yml up -d --wait
bun test test/kafka/kafka.e2e.test.ts
python3 -m venv .venv
.venv/bin/pip install -e './chkit_python[dev]'
.venv/bin/python -m pytest test/kafka/test_python_e2e.py -q
docker compose -p chkit-issue203 -f test/kafka/docker-compose.yml down -v
```

The default is ClickHouse 25.3 on localhost port 18203. To test another version,
set `CLICKHOUSE_VERSION=26.3` before `docker compose up`. Use `KAFKA_TEST_HTTP_PORT`
for a different exposed port and `CLICKHOUSE_URL` for the matching test URL.
If changing the Compose project name, pass `KAFKA_TEST_PROJECT` to the test too.
Use a separate project name and port when running tests in parallel.
Run `docker compose down -v` for this project before switching ClickHouse versions
so an older server does not inherit a newer server's data files.

The test creates unique topics/databases and cleans up only its own fixtures.
It verifies SQL migration execution, Kafka → MV → MergeTree ingestion, escaped
setting literals, pull/generate round trips, clean drift/check, settings drift,
rejection of unsupported changes without advancing snapshots, and an explicit
drop/create replacement with the existing destructive-operation gate.

The Python test uses its native CLI and schema DSL, including `drift --live` and
`check --live`. It also checks that offline drift/check report unsupported Kafka
changes without crashing. CI runs both workflows on ClickHouse 25.3 and 26.3.
