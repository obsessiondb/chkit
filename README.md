# chx

`chx` is a ClickHouse schema and migration CLI for TypeScript projects.

## Install & Run

```bash
bun install
bun run build
bun run chx --help
```

## Quick Start

```bash
bun run chx init
bun run chx generate --name init
bun run chx migrate
bun run chx migrate --apply
bun run chx status
bun run chx check
```

## Documentation

- Public docs site (Astro + Starlight): `apps/docs`
- Run locally: `bun run docs:dev`
- Build: `bun run docs:build`
- Internal planning docs: `planning/`

## Commands

- `chx init`
- `chx generate [--name <migration-name>] [--migration-id <id>] [--config <path>] [--dryrun] [--json]`
- `chx pull [--out-file <path>] [--database <db>] [--dryrun] [--force] [--config <path>] [--json]`
- `chx typegen [--check] [--out-file <path>] [--emit-zod] [--no-emit-zod] [--bigint-mode <string|bigint>] [--include-views] [--config <path>] [--json]`
- `chx migrate [--config <path>] [--apply|--execute] [--allow-destructive] [--json]`
- `chx status [--config <path>] [--json]`
- `chx drift [--config <path>] [--json]`
- `chx check [--config <path>] [--strict] [--json]`
- `chx plugin [<plugin-name> [<command> ...]] [--config <path>] [--json]`
- `chx version`

## Global Flags

- `--config <path>`: config file path (default: `clickhouse.config.ts`)
- `--json`: machine-readable command output

## What Each Command Does

### `chx init`

Creates starter files if missing:

- `clickhouse.config.ts`
- `src/db/schema/example.ts`

### `chx generate`

- Loads schema files from `config.schema`
- Validates definitions
- Diffs against `meta/snapshot.json`
- Writes migration SQL + updates snapshot (unless `--dryrun`)
- Runs `typegen` plugin automatically when configured with `runOnGenerate: true` (default)

### `chx typegen`

- Optional manual command to generate TypeScript types from schema definitions
- `--check` verifies generated output is up-to-date (no write)
- Supports optional Zod emission (`--emit-zod`)
- Returns non-zero on stale/missing artifacts in check mode

### `chx plugin pull schema`

- Pulls live ClickHouse table metadata and writes a local CHX schema file
- Supports `--out-file`, repeated `--database`, `--dryrun`, and `--force`
- Shortcut: `chx pull ...` (equivalent to `chx plugin pull schema ...`)

### `chx migrate`

- Always prints pending migration plan first
- Prompts for confirmation when run without `--apply` or `--execute`
- Applies pending migrations immediately when run with `--apply` (or alias `--execute`)
- Maintains `meta/journal.json`
- Blocks execution when:
  - applied-file checksums mismatch
  - pending migration includes destructive operations and `--allow-destructive` is not set in non-interactive mode (interactive mode prompts for explicit confirmation)

### `chx status`

Shows migration counts and checksum mismatch status.

### `chx drift`

Compares live ClickHouse objects to snapshot expectations and reports drift details.

Drift reason codes you may see:

- object-level: `missing_object`, `extra_object`, `kind_mismatch`
- table-level: `missing_column`, `extra_column`, `changed_column`, `setting_mismatch`, `index_mismatch`, `ttl_mismatch`, `engine_mismatch`, `primary_key_mismatch`, `order_by_mismatch`, `unique_key_mismatch`, `partition_by_mismatch`, `projection_mismatch`

### `chx check`

CI gate command. Evaluates:

- pending migrations
- checksum mismatches
- schema drift
- plugin checks (including `typegen` when configured)

Returns non-zero when enabled checks fail.

## Config (`clickhouse.config.ts`)

```ts
import { defineConfig } from '@chkit/core'
import { pull } from '@chkit/plugin-pull'
import { typegen } from '@chkit/plugin-typegen'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chx',
  migrationsDir: './chx/migrations',
  metaDir: './chx/meta',
  plugins: [
    pull({
      outFile: './src/db/schema/pulled.ts',
    }),

    // Typed registration (recommended):
    typegen({
      outFile: './src/generated/chx-types.ts',
      emitZod: false,
    }),

    // Legacy path-based registration (still supported):
    // './plugins/my-plugin.ts',
    // { resolve: './plugins/my-plugin.ts', options: { dryRun: true }, enabled: true },
  ],

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

### Plugin API v1

Plugin modules should export `definePlugin(...)` from `@chkit/cli`.

For typed config registration, plugin packages can export helpers that return inline registrations (for example `typegen(...)` from `@chkit/plugin-typegen`).

- `manifest.apiVersion` must be `1`.
- Optional compatibility gates:
  - `manifest.compatibility.cli.minMajor`
  - `manifest.compatibility.cli.maxMajor`
- Lifecycle hooks:
  - `onConfigLoaded`
  - `onSchemaLoaded`
  - `onPlanCreated`
  - `onBeforeApply`
  - `onAfterApply`
  - `onCheck`
  - `onCheckReport`
- Plugin command namespace:
  - `chx plugin`
  - `chx plugin <plugin-name>`
  - `chx plugin <plugin-name> <command> [args...]`

## Output Artifacts

Under `metaDir`:

- `snapshot.json`: canonical schema snapshot
- `journal.json`: applied migration journal

Under `migrationsDir`:

- `YYYYMMDDHHMMSS_<name>.sql`

## JSON Output Contract

- Contract document: `planning/07-json-output-contract.md`

## Contributor Docs

- Internal architecture and repository structure: `planning/08-internal-structure.md`
- Planning docs index: `planning/README.md`
