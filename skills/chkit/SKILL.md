---
name: chkit
description: ClickHouse schema management with chkit. Use when working with chkit CLI commands, ClickHouse table/view/materialized view definitions, migration generation, drift detection, or clickhouse.config.ts files. Trigger on chkit commands, @chkit/core imports, or schema definition tasks.
allowed-tools: [Read, Edit, Grep, Glob, Bash]
---

# chkit: ClickHouse Schema & Migration Toolkit

chkit lets you define ClickHouse schemas in TypeScript, generate migration SQL, detect drift, and run CI checks from a single CLI.

Docs: https://chkit.obsessiondb.com

For application API source authoring with `@chkit/plugin-ingest`, use the separate `chkit-ingestion` skill (`npx skills add obsessiondb/chkit --skill chkit-ingestion`) and the [API sync guides](https://chkit.obsessiondb.com/api-sync.md). Its streams and checkpoints are separate from plugin-codegen's generated insert helpers.

## Configuration

Use `clickhouse.config.ts` at the TypeScript project root, or pass a custom path with `--config`:

```ts
import { defineConfig } from '@chkit/core'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',    // Glob to schema files
  outDir: './chkit',                     // Artifact root
  migrationsDir: './chkit/migrations',   // SQL migration files
  metaDir: './chkit/meta',               // snapshot.json, journal.json
  plugins: [],                           // Plugin registrations
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: process.env.CLICKHOUSE_DB ?? 'default',
  },
  check: {
    failOnPending: true,
    failOnChecksumMismatch: true,
    failOnDrift: true,
  },
  safety: {
    allowDestructive: false,
  },
})
```

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
chkit migrate                  # Preview pending
chkit migrate --apply          # Apply all pending
chkit migrate --apply --allow-destructive   # Allow danger operations
chkit migrate --apply --table analytics.events
chkit migrate --apply --retry <file>        # Resume a failed migration after editing its file
chkit migrate --abandon <file> --apply      # Reset a failed migration so the next apply starts it over
```

Verifies checksums before applying. Destructive operations require explicit `--allow-destructive` in CI.

A migration that fails part-way stays in progress, and `--apply` resumes it, skipping completed statements. With chkit newer than 0.2.0-beta.8, after an edit to its file `--apply` runs it from statement 1 if no statement is recorded as completed; otherwise use `--retry` or `--abandon`, which preview without `--apply`. Never edit the `_chkit_migrations` journal by hand. These versions also refuse to apply pending files without executable statements, such as an unfilled `generate --empty` stub.

### status: Migration state

```sh
chkit status
# Output: Migrations: 5 total, 3 applied, 2 pending
```

Read-only; requires a ClickHouse connection to read the migration journal.

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
| `@chkit/plugin-backfill` | `bun add -d @chkit/plugin-backfill` | `chkit backfill` | Time-windowed data backfill with checkpoints |
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

## Structural vs Alterable Properties

When a property changes, chkit determines whether ALTER or DROP+CREATE is needed:

- **Structural** (requires drop+recreate): `engine`, `primaryKey`, `orderBy`, `partitionBy`, `uniqueKey`
- **Alterable** (ALTER in place): columns, indexes, projections, settings, TTL, comment

Views and materialized views always use drop+recreate.

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
| Codegen Plugin | `https://chkit.obsessiondb.com/plugins/codegen/` | TypeScript types, Zod schemas, ingest functions |
| Pull Plugin | `https://chkit.obsessiondb.com/plugins/pull/` | Introspecting live ClickHouse into schema files |
| Backfill Plugin | `https://chkit.obsessiondb.com/plugins/backfill/` | Time-windowed data backfill with checkpoints |
| CI/CD Integration | `https://chkit.obsessiondb.com/guides/ci-cd/` | Pipeline setup, check commands, deployment |

### Discover all pages

Fetch the index to find CLI command pages and any other documentation:

```sh
curl -s -H "Accept: text/markdown" https://chkit.obsessiondb.com/
```
