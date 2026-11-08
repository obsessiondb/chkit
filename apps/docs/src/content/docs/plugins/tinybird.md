---
title: Tinybird Plugin
description: Translate a Tinybird project into chkit tables, materialized views, refreshable materialized views and typed queries, with a report of what does not translate.
sidebar:
  order: 4
---

`@chkit/plugin-tinybird` reads a Tinybird (Forward) project folder and writes a chkit schema that, applied with [`chkit migrate`](/cli/migrate/) to plain ClickHouse, creates the objects Tinybird creates.

## What it does

- Translates datasources into `table()` definitions: columns with types, defaults and codecs, engine and engine parameters, partition, sorting and primary keys, TTL, settings (including the `ttl_only_drop_parts = 1` Tinybird adds) and skip indexes.
- Translates materialized pipes into `materializedView({ to, as })`, resolving multi-node pipes into the single SELECT Tinybird sends to ClickHouse.
- Translates copy pipes into refreshable materialized views, mapping `COPY_SCHEDULE` and `COPY_MODE` to `REFRESH EVERY … OFFSET …` and `APPEND`.
- Translates endpoints into typed queries (`query` and `p`) whose SQL is the SQL Tinybird runs.
- Reports every object it does not translate, with the reason, in the command output, the JSON report and the head of the generated schema file.

## How it fits your workflow

1. Point the plugin at the Tinybird project folder (the one with `tinybird.config.json`, or the datafiles).
2. Run `chkit plugin tinybird import`. It writes a schema file and, when an endpoint translates, a queries file.
3. Review the not-translated list and handle those objects by hand.
4. Run [`chkit generate`](/cli/generate/) and [`chkit migrate`](/cli/migrate/) against the target ClickHouse.

## Plugin setup

```ts
import { defineConfig } from '@chkit/core'
import { tinybird } from '@chkit/plugin-tinybird'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [
    tinybird({
      project: './tinybird',
      database: 'analytics',
      outFile: './src/db/schema/tinybird.ts',
      queriesOutFile: './src/db/queries/tinybird.ts',
    }),
  ],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  },
})
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `project` | `string` | `.` | Tinybird project folder. `tinybird.config.json` `folder` is honoured |
| `database` | `string` | `default` | ClickHouse database every imported object is created in |
| `outFile` | `string` | `./src/db/schema/tinybird.ts` | Schema file to write |
| `queriesOutFile` | `string` | `./src/db/queries/tinybird.ts` | Typed queries file, written when at least one endpoint translates |
| `reportFile` | `string` | — | Write the import report (every object, its outcome and reasons) as JSON |
| `overwrite` | `boolean` | `false` | Overwrite existing output files |

The import reads only local files; it does not connect to Tinybird or ClickHouse.

## Commands

### `chkit plugin tinybird import`

| Flag | Required | Description |
|------|----------|-------------|
| `--project <dir>` | No | Tinybird project folder |
| `--database <name>` | No | ClickHouse database for the imported objects |
| `--out-file <path>` | No | Schema file to write |
| `--queries-out-file <path>` | No | Typed queries file to write |
| `--report <path>` | No | Write the import report as JSON |
| `--force` | No | Overwrite existing output files |
| `--dryrun` | No | Print the result without writing files |

The command exits `0` when the import ran, also when some objects do not translate; `1` when a datafile cannot be read; `2` when an output file exists and `--force` is not set. With `--json` it prints `{ ok, command, outFile, queriesOutFile, counts, entries, copyFallbacks, warnings, dryrun }`.

## Translation rules

### Datasources

| Datafile | chkit |
|----------|-------|
| `SCHEMA` column `` `name` Type `json:$.path` DEFAULT expr CODEC(...) `` | column with `type`, `default: { expression }` and `codec`; the JSONPath is ingestion only and is noted in the report |
| `ENGINE` and `ENGINE_VER`, `ENGINE_IS_DELETED`, `ENGINE_COLUMNS`, `ENGINE_SIGN`, `ENGINE_VERSION` | `engine`, with the parameters in the order Tinybird passes them, e.g. `ReplacingMergeTree(ver, is_deleted)` |
| `ENGINE_SORTING_KEY`, `ENGINE_PRIMARY_KEY`, `ENGINE_PARTITION_KEY`, `ENGINE_TTL` | `orderBy`, `primaryKey`, `partitionBy`, `ttl` |
| `ENGINE_SETTINGS` | `settings`, plus `ttl_only_drop_parts = 1` where Tinybird adds it: when the TTL is one `column ± interval` on the partition column and the interval is at least the partition period |
| `INDEXES` | `indexes` |

### Materialized pipes

The view is named after the pipe and writes `TO` the `DATASOURCE`. Nodes the materialized node reads are inlined as `(SELECT …) AS <node>`, and every datasource is written as `<database>.<name> AS <name>`, as Tinybird does before it creates the view.

### Copy pipes

The copy becomes a refreshable materialized view named after the pipe, `TO` the `TARGET_DATASOURCE`, with `APPEND` for `COPY_MODE append` (the default) and without it for `replace`, and `EMPTY`, because Tinybird does not copy on deploy. `COPY_SCHEDULE` translates when ClickHouse fires at the same instants:

| Cron | Refresh |
|------|---------|
| `*/N * * * *` (N divides 60) | `EVERY N MINUTE` |
| `M * * * *` | `EVERY 1 HOUR OFFSET M MINUTE` |
| `M */N * * *` (N divides 24) | `EVERY N HOUR OFFSET M MINUTE` |
| `M H * * *` | `EVERY 1 DAY OFFSET H HOUR M MINUTE` |
| `M H * * D` | `EVERY 1 WEEK OFFSET …` (weeks start on Monday) |
| `M H DOM * *` (DOM up to 28) | `EVERY 1 MONTH OFFSET (DOM-1) DAY …` |

:::caution
ClickHouse aligns `REFRESH` to the server timezone; Tinybird runs schedules in `Etc/UTC`. Run the target server in UTC, or adjust the offsets.
:::

`@on-demand` copies and other crons (ranges, lists, a month field, days 29–31) are not translated: a refreshable view would run on a schedule Tinybird never had. The report keeps their resolved SELECT and target (`copyFallbacks`) so they can run as `INSERT INTO <target> <select>` from a scheduler.

### Endpoints

Each translated endpoint becomes `export const <pipe> = query({ name: '<pipe>' })`…``. Tinybird inlines a typed param as a literal (`{{ Int32(limit, 100) }}` → `toInt32('100')`, `{{ DateTime(start, '…') }}` → `'…'`); the query binds the param as a ClickHouse `String` inside the same function, `toInt32({limit:String})`, so ClickHouse runs the SQL Tinybird runs while `p` still validates the value as the type. A default becomes `.default(…)`; `required=True` makes the param required.

Translated param types: `String`, `Int8`–`Int64`, `UInt8`–`UInt64`, `Float32`, `Float64`, `Date`, `DateTime`, `DateTime64`. Endpoints with control flow (`{% if %}`), `defined()`, `column()`, `Array()`, `Boolean()` or a param with neither a default nor `required=True` are reported as not translated.

### Not translated

- `ENGINE_SAMPLING_KEY`: the chkit table DSL has no `SAMPLE BY`. Pipes that read such a datasource are not translated either.
- Templated SQL in materialized and copy pipes, reads of Tinybird service datasources (`tinybird.*`) and of other workspaces.
- Ingestion (Events API, connectors, JSONPaths at runtime), tokens, sinks and connection files.

## Parity with Tinybird

The translation is checked object by object against what Tinybird itself creates on Tinybird Local: the stored `CREATE` statements of tables and materialized views, the SELECT Tinybird runs for each copy (`/v0/pipes/<pipe>/explain`) and its schedule (the next refresh time ClickHouse reports equals the next cron fire), and the SQL Tinybird renders for each endpoint with its defaults and with every param set. The comparison applies only these normalisations: Tinybird's `COMMENT '{"resource_name": …}'` bookkeeping is dropped, a `PRIMARY KEY` equal to `ORDER BY` is dropped (chkit always writes it), and settings and skip indexes are compared as sets (chkit orders them by name).

## Common workflows

**Preview an import:**

```sh
chkit plugin tinybird import --project ./tinybird --database analytics --dryrun
```

**Import, then plan the migration:**

```sh
chkit plugin tinybird import --project ./tinybird --database analytics --report ./tinybird-import.json
chkit generate --name import_tinybird
chkit migrate --apply
```

**List what did not translate:**

```sh
chkit plugin tinybird import --dryrun --json | jq '.entries[] | select(.status == "untranslatable")'
```

## Related pages

- [`chkit plugin`](/cli/plugin/) — run plugin commands
- [Pull plugin](/plugins/pull/) — import a live ClickHouse schema instead of Tinybird datafiles
- [Schema DSL reference](/schema/dsl-reference/) — `table`, `materializedView` and refresh options
- [`chkit generate`](/cli/generate/) — plan the migration for the imported schema
