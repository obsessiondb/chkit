---
name: chkit
description: ClickHouse schema management with chkit. Use when working with chkit CLI commands, ClickHouse table/view/materialized view definitions, migration generation, drift detection, or clickhouse.config.ts files. Trigger on chkit commands, @chkit/core imports, or schema definition tasks.
allowed-tools: [Read, Edit, Grep, Glob, Bash]
---

# chkit: ClickHouse Schema & Migration Toolkit

chkit lets you define ClickHouse schemas in TypeScript, generate migration SQL, detect drift, and run CI checks from a single CLI.

Docs: https://chkit.obsessiondb.com

## Connection and authorization

Use choices, target details and apply authorization already supplied by the user; ask only for missing information. Keep the workflow focused on TypeScript schema management unless the user asks for Sync or Python.

For a direct ClickHouse target, obtain `CLICKHOUSE_URL` (HTTP/S endpoint and port), `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` (explicitly empty is valid), and `CLICKHOUSE_DB`. Never infer localhost, a default username, an empty password or the database `default` as the user's verified target. Do not provision a managed instance unless requested.

Without credentials, install dependencies and prepare definitions offline. Generate migration SQL only after the database namespace is explicitly chosen. Do not run connected `pull`, `query`, `status`, `drift`, `check` or `migrate` against guessed endpoints. If the database name is unknown, ask for it and leave generation pending; do not invent a namespace. If a previous attempt emitted SQL against a placeholder, retarget definitions and regenerate only **never-applied** initial artifacts before connecting. Record what is prepared and what remains unverified.

Keep real credentials in the process environment or an ignored `.env`, never schema/migration/handoff files. Bun loads a root `.env`; npm/Node commands need explicit loading, such as `node --env-file=.env ./node_modules/chkit/dist/bin/chkit.js check --strict --json` from the root. Nested configs need a loader that resolves the root `.env` deliberately.

Before applying, verify the actual database identity and review generated SQL. Honor explicit development-database authorization without asking for repeat approval; obtain authorization for consequential writes that the task has not authorized. Missing credentials are required input, not a reason to stop offline work.

## Configuration

Use `clickhouse.config.ts` at the project root, or pass a custom path with `--config`. Share the chosen database name with schema files; every managed object's `database` must target the intended database.

```ts
import { defineConfig } from '@chkit/core'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || (name !== 'CLICKHOUSE_PASSWORD' && !value.trim())) {
    throw new Error(`Missing ${name}; configure the connection first.`)
  }
  return value
}

export default defineConfig(({ command }) => ({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  migrationsDir: './chkit/migrations',
  metaDir: './chkit/meta', // snapshot.json; applied history is in ClickHouse
  plugins: [],
  // Preserve target metadata when supplied, including during generation.
  clickhouse: !process.env.CLICKHOUSE_URL && (command === 'generate' || command === 'snapshot') ? undefined : {
    url: required('CLICKHOUSE_URL'),
    username: required('CLICKHOUSE_USER'),
    password: required('CLICKHOUSE_PASSWORD'),
    database: required('CLICKHOUSE_DB'),
  },
  check: { failOnPending: true, failOnChecksumMismatch: true, failOnDrift: true },
  safety: { allowDestructive: false },
}))
```

`generate` is offline and diffs definitions against the snapshot. The live `_chkit_migrations` table stores applied history; there is no local `journal.json`. A connected migration preview may bootstrap that journal even though it does not execute pending migration statements.

## Schema DSL

Schema files are TypeScript files that export definitions using functions from `@chkit/core`.

### Tables

```ts
import { schema, table } from '@chkit/core'

const events = table({
  database: 'default',
  name: 'events',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'org_id', type: 'String' },
    { name: 'source', type: 'LowCardinality(String)' },
    { name: 'payload', type: 'String', nullable: true },
    { name: 'received_at', type: 'DateTime64(3)', default: { expression: 'now64(3)' } },
    { name: 'status', type: 'String', default: 'pending', comment: 'Processing status' },
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

Required table fields: `database`, `name`, `columns`, `engine`, `primaryKey`, `orderBy`.
Optional: `partitionBy`, `uniqueKey`, `ttl`, `settings`, `indexes`, `projections`, `comment`, `renamedFrom`.

### Column defaults

- Strings are literals, single-quoted: `default: 'pending'` → `DEFAULT 'pending'`
- Numbers and booleans are literals: `default: 0` → `DEFAULT 0`
- SQL expressions use `{ expression }`: `default: { expression: 'now64(3)' }` → `DEFAULT now64(3)`. Comments in the expression are dropped from the rendered SQL
- Never write a function call as a plain string: `default: 'now64(3)'` is the literal text `now64(3)`, which ClickHouse rejects for a DateTime64 column (and stores as NULL in a Nullable one). chkit newer than 0.2.0-beta.8 rejects it at `generate` when it is the `DEFAULT` or `EPHEMERAL` default of a non-string column (`column_default_looks_like_expression`), and rejects every plain string on a `MATERIALIZED` or `ALIAS` column (`column_expression_requires_fn`)
- `default: 'fn:now64(3)'` is the legacy, equivalent spelling, and the only one chkit 0.2.0-beta.8 and older understand: they render `{ expression }` as `DEFAULT [object Object]`. If the generated migration shows that, use `fn:`
- `defaultKind` picks the clause (`DEFAULT`, `MATERIALIZED`, `ALIAS`, `EPHEMERAL`); `default` keeps the same forms for every kind: `{ name: 'day', type: 'Date', defaultKind: 'MATERIALIZED', default: { expression: 'toDate(ts)' } }` → `` `day` Date MATERIALIZED toDate(ts) ``. `MATERIALIZED` and `ALIAS` need a `default`, written as `{ expression }` (a constant string is `{ expression: "'text'" }`); `EPHEMERAL` may omit it

### Views

```ts
import { view } from '@chkit/core'

const activeUsers = view({
  database: 'app',
  name: 'active_users',
  as: 'SELECT id, email FROM app.users WHERE active = 1',
})
```

Write fully qualified `db.name` references in view SQL (`app.users`, not `users`): ClickHouse resolves an unqualified name against the session's current database. chkit newer than 0.2.0-beta.8 also reads these references to create a view after the views, materialized views, and dictionaries it uses.

With chkit newer than 0.2.0-beta.8, `as` may span lines and contain SQL comments, as may the other SQL fields (materialized view `as`, `partitionBy`, `ttl`, index and projection SQL, dictionary `source`/`layout`/`lifetime`): chkit removes the comments before it writes the query on one line. Full-text (`type: 'text'`) index expressions are the exception: they only drop `--` and non-nested `/* */` comments. Check the generated migration: if a `--`, `//`, or `#` comment outside a string literal is still inside a one-line statement (a `CREATE VIEW`, or the TTL or PARTITION BY of a `CREATE TABLE`), the installed chkit does not strip comments and the comment swallows the rest of the statement. Upgrade chkit, or use `/* */` comments.

### Materialized views

```ts
import { materializedView } from '@chkit/core'

const eventCounts = materializedView({
  database: 'analytics',
  name: 'event_counts_mv',
  to: { database: 'analytics', name: 'event_counts' },
  as: 'SELECT org_id, count() AS total FROM analytics.events GROUP BY org_id',
})
```

### Exporting

Use `schema()` to group definitions, or export individually (any export with a valid `kind` is discovered):

```ts
export default schema(users, events, eventCounts)
// or
export const users = table({ ... })
export const events = table({ ... })
```

## CLI Commands

All commands support `--json` for machine-readable output and `--config <path>` for custom config files.

### init: Scaffold project

```sh
chkit init
```

Creates `clickhouse.config.ts` and `src/db/schema/example.ts`.

### generate: Create migrations

```sh
chkit generate --name add-users-table
chkit generate --dryrun                        # Preview without writing
chkit generate --table analytics.events        # Scope to specific table
chkit generate --rename-table old.users=new.accounts
chkit generate --rename-column db.table.old=new
```

Diffs schema definitions against the last snapshot. Each operation gets a risk level:
- **safe**: `CREATE TABLE`, `ADD COLUMN`
- **caution**: settings changes
- **danger**: `DROP TABLE`, `DROP COLUMN`

### migrate: Apply migrations

```sh
chkit migrate --json           # Preview pending without applying
chkit migrate --apply          # Apply all pending
chkit migrate --apply --allow-destructive   # Allow danger operations
chkit migrate --apply --table analytics.events
chkit migrate --apply --retry <file>        # Resume a failed migration after editing its file
chkit migrate --abandon <file> --apply      # Reset a failed migration so the next apply starts it over
```

Verifies checksums before applying. Destructive operations require explicit `--allow-destructive` in CI.

A migration that fails part-way stays in progress, and `--apply` resumes it, skipping completed statements. With chkit newer than 0.2.0-beta.8, after an edit to its file `--apply` runs it from statement 1 if no statement is recorded as completed; otherwise use `--retry` or `--abandon`, which preview with `--json` and without `--apply`. Never edit the `_chkit_migrations` journal by hand. These versions also refuse to apply pending files without executable statements, such as an unfilled `generate --empty` stub.

### status: Migration state

```sh
chkit status
# Output: Migrations: 5 total, 3 applied, 2 pending
```

Requires a ClickHouse connection to read the migration journal. Connected setup can create the journal if it is absent; it does not apply pending migration statements.

### drift: Compare live vs expected

```sh
chkit drift
chkit drift --table analytics.events
```

Compares snapshot against live ClickHouse. Reports missing/extra objects and column-level differences.

### check: CI gate

```sh
chkit check              # Run all policy checks
chkit check --strict     # Force all policies on
chkit check --json       # Machine-readable output
```

Evaluates: pending migrations, checksum mismatches, schema drift, plugin checks. Exit code 1 on failure.

### snapshot: Repair snapshot.json after parallel branches

Requires chkit newer than 0.2.0-beta.8.

```sh
chkit snapshot rebuild --dryrun   # Report the entries that differ from the current snapshot.json
chkit snapshot rebuild            # Rewrite chkit/meta/snapshot.json from the schema definitions
```

Use when `snapshot.json` has merge conflict markers after merging or rebasing two branches that each ran `generate`. Resolve schema file conflicts first. Never take one side of the conflict or edit the file by hand: that drops the other branch's entries. A conflicted file cannot be compared, so review the rebuilt file before staging it: `git diff HEAD -- chkit/meta/snapshot.json`, then the same diff against `MERGE_HEAD` during a merge or `REBASE_HEAD` during a rebase. A rebuild records every definition as migrated, so rebuild only when every schema change has a migration file (`chkit generate --dryrun` reported 0 operations on each branch); after upgrading chkit, run `chkit generate` first. Restore the snapshot from git instead of rebuilding when the file is damaged but committed and no merge or rebase is in progress (`git checkout HEAD -- chkit/meta/snapshot.json`), or after abandoning a failed migration to generate it again. `--table` is not supported. If both branches changed the same table or view, add a migration that applies it again: https://chkit.obsessiondb.com/cli/snapshot/

### query: Run SQL against the configured target

```sh
chkit query "SELECT count() FROM users"
chkit query "SELECT count() FROM users" --json
chkit query "SELECT count() FROM users" --service customer-b  # ObsessionDB plugin
```

Uses the active executor: direct `clickhouse` config by default, or the ObsessionDB plugin service when loaded.

## Rename Workflow

To rename a table or column without drop+recreate:

**Table rename**: set `renamedFrom` on the table:
```ts
const accounts = table({
  database: 'app',
  name: 'accounts',           // new name
  renamedFrom: { name: 'users' },  // old name
  // ... columns, engine, etc.
})
```

**Column rename**: set `renamedFrom` on the column:
```ts
columns: [
  { name: 'user_email', type: 'String', renamedFrom: 'email' },
]
```

CLI flags override schema metadata: `--rename-table old=new`, `--rename-column db.table.old=new`.

## Plugins

Register plugins in `clickhouse.config.ts`:

```ts
import { codegen } from '@chkit/plugin-codegen'

export default defineConfig({
  plugins: [
    codegen({ outFile: './src/generated/chkit-types.ts', emitZod: true }),
  ],
})
```

### Available plugins

| Plugin | Install | Command | Purpose |
|--------|---------|---------|---------|
| `@chkit/plugin-codegen` | `bun add -d @chkit/plugin-codegen` | `chkit codegen` | Generate TypeScript types + Zod schemas |
| `@chkit/plugin-pull` | `bun add -d @chkit/plugin-pull` | `chkit pull` | Introspect live ClickHouse into schema files |
| `@chkit/plugin-backfill` | `bun add -d @chkit/plugin-backfill` | `chkit plugin backfill` | Partition/sort-key replay with checkpoints |
| `@chkit/plugin-obsessiondb` | `bun add -d @chkit/plugin-obsessiondb` | `chkit query --service <name>` | Route commands through an ObsessionDB service |

## Common Workflows

### New project

```sh
bun add -d chkit
bunx chkit init
# Edit src/db/schema/example.ts with your tables
bunx chkit generate --name init
bunx chkit migrate --apply
```

### Add a table

1. Create a new schema file in `src/db/schema/`
2. Define the table using `table()` and export via `schema()`
3. Run `chkit generate --name add-my-table`
4. Run `chkit migrate --apply`

### CI pipeline

```sh
chkit check --strict --json
# Fails if: pending migrations, checksum mismatches, schema drift, or plugin errors
```

### Adopt an existing populated database

Follow [the complete adoption guide](https://chkit.obsessiondb.com/getting-started/add-to-existing-project/). Pull imports definitions, not applied history. Review a generated baseline against live definitions; `CREATE ... IF NOT EXISTS` alone does not validate a pre-existing object. Remove only redundant database provisioning from the unapplied baseline when using an existing scoped target, apply normally, then verify data/view preservation, journal checksums and live drift before the next ALTER. Never edit the journal or rebuild a snapshot to pretend adoption is applied.

## Structural vs Alterable Properties

When a property changes, chkit determines whether ALTER or DROP+CREATE is needed:

- **Structural** (requires drop+recreate): `engine`, `primaryKey`, `orderBy`, `partitionBy`, `uniqueKey`
- **Alterable** (ALTER in place): columns, indexes, projections, settings, TTL, comment

Views and materialized views always use drop+recreate.

For populated structural changes, do not apply the generated DROP/CREATE as a data-preservation solution. Use [the staged copy/validate/cutover recipe](https://chkit.obsessiondb.com/guides/data-preserving-migrations/), with explicit writer coordination, recovery and tracked SQL migrations.

The backfill plugin currently chunks by physical partitions and sorting keys; `--from`/`--to` select partitions using metadata, not arbitrary timestamp-column row predicates. `--time-column` and `--chunk-hours` are not current planning flags. A new plan gets a new identity; resume the saved plan rather than replanning to retry. MV replay is for historical aggregate targets; a same-table copy can duplicate ordinary MergeTree rows. Use tracked SQL for an arbitrary source-to-shadow transformation and inspect the generated plugin SQL before execution.

## Documentation

Read the documentation at https://chkit.obsessiondb.com. Request pages with `Accept: text/markdown` for Markdown output. Fetch the relevant guide for details beyond this skill.

```sh
curl -s -H "Accept: text/markdown" <url>
```

### Key pages

| Page | URL | Use when |
|------|-----|----------|
| Schema DSL Reference | `https://chkit.obsessiondb.com/schema/dsl-reference/` | Full field specs, column types, validation rules |
| Configuration | `https://chkit.obsessiondb.com/configuration/overview/` | All config options and defaults |
| Codegen Plugin | `https://chkit.obsessiondb.com/plugins/codegen/` | TypeScript types, Zod schemas, typed insert helpers |
| Pull Plugin | `https://chkit.obsessiondb.com/plugins/pull/` | Introspecting live ClickHouse into schema files |
| Backfill Plugin | `https://chkit.obsessiondb.com/plugins/backfill/` | Partition/sort-key replay with checkpoints |
| CI/CD Integration | `https://chkit.obsessiondb.com/guides/ci-cd/` | Pipeline setup, check commands, deployment |

### Discover all pages

Fetch the index to find CLI command pages and any other documentation:

```sh
curl -s -H "Accept: text/markdown" https://chkit.obsessiondb.com/
```
