# Hello chkit example

Two MergeTree tables, `users` and `events`, and one migration that creates them. No dataset load.

## Scaffold

```bash
bun create chkit@latest my-chkit-app --example hello
cd my-chkit-app
```

The scaffolder asks how to connect. Choose **Claim a free ObsessionDB dev instance** and enter the emailed code. That creates a personal organization, provisions a free instance, and selects it.

To use an existing ClickHouse instead, choose **I already have a ClickHouse instance** and set `CLICKHOUSE_URL`.

`clickbench` stays available for the full public dataset:

```bash
bun create chkit@latest my-chkit-app --example clickbench
```

## Or clone this folder

```bash
cd examples/hello
bun install
```

Claim a free ObsessionDB dev instance:

```bash
bunx chkit obsessiondb signup
bunx chkit obsessiondb service claim
```

Or point at a local ClickHouse:

```bash
export CLICKHOUSE_URL=http://localhost:8123
# export CLICKHOUSE_USER=default
# export CLICKHOUSE_PASSWORD=...
```

## Migrate

```bash
bun run migrate
```

## Confirm

```bash
bunx chkit query "SELECT name FROM system.tables WHERE database = 'default' AND name IN ('users', 'events') ORDER BY name"
```

Both tables come back:

```
name
────
events
users
```

Stop there. The tables are empty.

## Schema

`src/db/schema/hello.ts` defines both tables. `chkit/migrations/20260928082853_create_hello_schema.sql` creates them.

## Dependency security

This example pins published chkit packages. Those releases still depend on vulnerable `@orpc/client` and `@orpc/contract` versions. The `overrides` in `package.json` replace them with `1.15.4`, including when this folder is copied out of the monorepo.
