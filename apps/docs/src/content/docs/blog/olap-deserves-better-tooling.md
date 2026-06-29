---
title: The era of OLAP deserves the tooling relational has had for years
description: "Why we built ch-kit: schema-as-code, migrations, and guardrails for ClickHouse, after running it at near-petabyte scale."
date: 2026-06-25
authors: obsessiondb
excerpt: "If you build on Postgres or MySQL, you have not hand-written a migration in years. ClickHouse should not be the exception. Here is why we built ch-kit, after running ClickHouse at near-petabyte scale."
tags:
  - announcement
  - clickhouse
---

If you build on Postgres or MySQL, you have not hand written a migration in years. You change a TypeScript schema, a tool diffs it, generates the SQL, applies it, and fails your CI if production has drifted. Drizzle, Prisma, and Flyway made that the default. It is boring, and boring is exactly what you want from the thing that changes your database.

Now switch to ClickHouse®. Suddenly you are back in 2010: hand written DDL, diffs done by eye, a `migrations/` folder that may or may not match what is actually running, and a sinking feeling every time someone runs an `ALTER` in production. OLAP is becoming the default for analytics, but the tooling around it never caught up to what the relational world treats as table stakes.

We felt this acutely. In our previous venture, Numia, we ran ClickHouse at near-petabyte scale for real-time blockchain analytics. We hit two walls. The first was scaling the database like serious infrastructure. The second was the complete absence of tooling to manage the schema as code. We built [ObsessionDB](https://obsessiondb.com), managed ClickHouse with decoupled storage and compute, to solve the first. **ch-kit** is how we are solving the second, and it is open source.

This post is about the second wall, and what schema-as-code for ClickHouse actually looks like once you have it.

## The problem with hand written DDL

A ClickHouse schema is not just a list of columns. A single `MergeTree` table carries an engine, a sorting key, a partitioning expression, TTL rules, skip indexes, projections, codecs, and table settings. Materialized views point at target tables. Some of those properties can be altered in place. Some cannot, and changing them means a drop and recreate, which on a large table is not a thing you discover by accident.

When all of that lives in raw SQL files, three failures show up over and over:

1. **Drift.** Someone runs a manual `ALTER` to fix an incident at 3am. The fix never makes it back into a migration file. Now your repository and your production database disagree, and nothing tells you.
2. **Unsafe changes.** A migration drops a column. The reviewer did not notice. It runs in CI on a Friday. The data is gone.
3. **No source of truth.** The schema is whatever the sum of every migration file happens to produce. To know the current shape of a table, you read the database, not your code.

Relational tooling solved all three. ch-kit solves them for ClickHouse.

## Define your schemas in TypeScript

In ch-kit, tables, views, and materialized views are TypeScript values. Here is a real table definition, with the features you actually use in production:

```ts
import { schema, table } from '@chkit/core'

const events = table({
  database: 'analytics',
  name: 'events',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'org_id', type: 'String' },
    { name: 'source', type: 'LowCardinality(String)' },
    { name: 'payload', type: 'String', nullable: true },
    { name: 'received_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['org_id', 'received_at', 'id'],
  partitionBy: 'toYYYYMM(received_at)',
  ttl: 'received_at + INTERVAL 90 DAY',
  settings: { index_granularity: 8192 },
  indexes: [
    { name: 'idx_source', expression: 'source', type: 'set', maxRows: 0, granularity: 1 },
  ],
})

export default schema(events)
```

This is the desired state of your database, expressed as code, type checked, reviewable in a pull request, and split across as many files as you want. Materialized views and refreshable views are first class, including the `to` target table and refresh schedules. Compression codecs are typed too, so a column codec chain like `[{ kind: 'DoubleDelta' }, { kind: 'ZSTD', level: 3 }]` is validated rather than stringly typed.

You do not write SQL to define this. You write SQL for your queries, because ch-kit is not an ORM and has no opinion about how you read your data. It only owns the schema, the migrations, and the guardrails.

## Migrations are diffs, not artifacts you maintain

As we've mentioned already multiple times, with ch-kit you just change the TypeScript, and the rest is handled for you. Migrations are part of it.

```sh
chkit generate --name add_events_table
```

With `generate`, ch-kit loads your TS definitions, compares them against the previous snapshot, computes an ordered plan, and writes a migration SQL file plus an updated snapshot. If nothing changed, no file is created. Every operation in the plan is tagged with a risk level:

| Risk | Meaning | Examples |
| --- | --- | --- |
| `safe` | No data loss | `CREATE TABLE`, `ADD COLUMN` |
| `caution` | Review recommended | settings changes |
| `danger` | Destructive | `DROP TABLE`, `DROP COLUMN` |

Here is a detail that matters and that most ad hoc setups get wrong. ch-kit knows which schema properties are structural and which are alterable. Changing columns, indexes, projections, settings, or TTL is an `ALTER` in place. Changing the engine, `primaryKey`, `orderBy`, `partitionBy`, or `uniqueKey` is structural, which means a drop and recreate. ch-kit makes that distinction explicit in the plan instead of letting you find out in production that your "small" change rewrites the whole table.

Renames are tracked, not guessed. Mark a column or table with `renamedFrom` (or pass `--rename-table` / `--rename-column`) and ch-kit emits a real rename instead of a destructive drop and add:

```ts
columns: [
  { name: 'user_email', type: 'String', renamedFrom: 'email' },
]
```

## Applying changes without losing data

Once you have your migrations defined with `generate`, you can preview the impact by running `chkit migrate`. This will dry run and show you the plan. If you like what you see, just add `--apply` at the end for the actual run:

```sh
chkit migrate            # shows the plan
chkit migrate --apply    # applies pending migrations
```

Three guardrails run on every apply:

- **Destructive operations are blocked.** Any migration containing a `risk=danger` operation, a `DROP TABLE` or `DROP COLUMN`, requires explicit approval. In an interactive terminal you get a prompt. In CI, the command exits with code 3 and refuses to run unless you pass `--allow-destructive` or set `safety.allowDestructive` in config. The error payload tells you exactly which migration and which operation, with an impact description and a recommendation. Your data does not disappear because a reviewer was tired.
- **Checksums are verified.** Every applied migration is recorded in a `_chkit_migrations` journal table in ClickHouse along with a SHA-256 hash of the file content. If a migration file is edited after it was applied, the next run aborts before touching anything. Migration history is immutable, and ch-kit enforces it.
- **It is built for CI.** The CLI detects non-interactive environments (`CI=true`, no TTY) and never blocks on a prompt. Every command supports `--json` with a stable output envelope, so you can parse results with `jq` and build approval gates.

## Don't let your project drift!

ch-kit also implements a `drift` command that introspects the live database and compares it, object by object and column by column, against your snapshot:

```sh
chkit drift --json
```

It reports missing objects, extra objects, changed columns, and mismatches on settings, TTL, indexes, `ORDER BY`, `PARTITION BY`, primary keys, and projections. It is detailed enough that the 3am manual `ALTER` shows up the next morning as a concrete, named difference instead of a vague feeling that something is off.

In CI you turn that signal into a gate with `chkit check`:

```sh
chkit check --strict --json
```

`check` evaluates three policies, all on by default: fail on pending migrations, fail on checksum mismatch, fail on drift. The `--strict` flag forces them on regardless of config, so a permissive local setting never leaks into your pipeline. A full pull request gate is a few lines:

```yaml
- name: Check schema consistency
  run: npx chkit check --strict --json

- name: Verify generated types
  run: npx chkit codegen --check --json
```

That `codegen --check` step is the other half. ch-kit generates TypeScript row types (and optional Zod schemas) from the same definitions, so your application types and your database schema cannot quietly diverge either.

## Works with any ClickHouse

ch-kit is not a lock-in play. We run ObsessionDB, a managed ClickHouse offering that competes with ClickHouse Cloud, Altinity, and the rest. But we love ClickHouse, and we believe the tooling around it should be available to everyone using the technology, because that is what strengthens the ecosystem. So ch-kit runs against ObsessionDB, ClickHouse Cloud, Altinity, or any other managed or self-hosted ClickHouse.

The only managed-specific touch is that `Shared*` engine prefixes (`SharedMergeTree`, `SharedReplacingMergeTree`, and so on) are normalized away during comparison, so managed engines do not show up as false drift. If you run ObsessionDB, the first-party plugin keeps your schema on the right `Shared*` engines automatically, from the exact same TypeScript you use locally. If you do not, those engine variants are stripped for your target. Same schema, different backends.

It is MIT licensed, written in TypeScript, runs on Node 20+ or Bun, and needs ClickHouse 24.x or newer. It is beta: the CLI surface and the schema DSL are stable and run our own production workloads today, and we may still make small breaking changes before 1.0.

## Start from where you already are

Most teams adopting ch-kit are not starting from an empty database. They already have ClickHouse in production, with tables that matter and data they cannot lose. Either way, the first step is the same: get a project scaffolded.

If you are starting from scratch, `npm create chkit@latest` gives you a working project from a curated example:

```sh
npm create chkit@latest
```

If you are adding ch-kit to an existing TypeScript project, `chkit init` writes the project config (`clickhouse.config.ts`, with the ClickHouse connection block reading from environment variables) and a starter schema file. It is idempotent, so running it on an existing project leaves your files untouched.

```sh
# before: your existing TypeScript project
# my-app/
# ├── package.json
# ├── tsconfig.json
# └── src/
#     └── index.ts

$ chkit init
Created clickhouse.config.ts
Created src/db/schema/example.ts

# after: chkit added exactly two files, nothing else touched
# my-app/
# ├── clickhouse.config.ts          ← config: ClickHouse connection + plugins
# ├── package.json
# ├── tsconfig.json
# └── src/
#     ├── index.ts
#     └── db/
#         └── schema/
#             └── example.ts        ← starter schema: an `events` table
```

If you are starting fresh, edit the generated example schema to match the tables you want, then move on to `generate`.

If you already run ClickHouse, the next command is `chkit pull`. It introspects your live database and writes a deterministic TypeScript schema file from what is actually there:

```sh
# 1) install the pull plugin
npm install -D @chkit/plugin-pull

# 2) register it in clickhouse.config.ts:
#      import { pull } from '@chkit/plugin-pull'
#      plugins: [pull({ outFile: './src/db/schema/pulled.ts' })]

# 3) introspect your live database into TypeScript
chkit pull --out-file ./src/db/schema/pulled.ts
```

This is the step that turns an existing production database into version-controlled code. You do not transcribe table definitions by hand and hope you got the `ORDER BY` and the codecs right. ch-kit reads them. The output is deterministic, so it produces clean, reviewable diffs instead of churn, and you can scope it to specific databases with `--database` or preview it with `--dryrun` before writing anything.

Once you have pulled, prove the result immediately:

```sh
chkit drift
```

If your code matches production, drift reports nothing. That zero-drift result is the moment your database stops being the source of truth and your repository takes over. From here, every future change starts in TypeScript:

```sh
chkit generate --name init
chkit migrate --apply
chkit drift
```

## Want more? Check the rest of the features!

:::tip
We have only covered the initial bits of what ch-kit can do here. The [docs](https://chkit.obsessiondb.com) go into more detail on getting started no matter your case, and on everything else the tooling can do.
:::

The relational world stopped hand writing migrations a long time ago. OLAP should not be the exception. If you run ClickHouse and you are still managing schema by hand, we built ch-kit so you do not have to.

- **Repo:** <https://github.com/obsessiondb/chkit>
- **Docs:** <https://chkit.obsessiondb.com/getting-started/>
- **Install:** <https://www.npmjs.com/package/chkit>

If you do not use TypeScript but Python, do not worry: we will publish a Python port in the coming weeks. And since ch-kit is open source, if you feel something is missing, you are more than welcome to open an issue or a PR.

Stay tuned!

---

*ClickHouse® is a registered trademark of ClickHouse, Inc.*
