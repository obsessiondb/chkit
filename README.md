# chkit

`chkit` is a ClickHouse schema and migration CLI for TypeScript projects.

## Install & Run

```bash
bun install
bun run build
bun run chkit --help
```

## Quick Start

```bash
bun run chkit init
bun run chkit generate --name init
bun run chkit migrate
bun run chkit migrate --apply
bun run chkit status
bun run chkit check
```

## Documentation

- Public docs site (Astro + Starlight): `apps/docs`
- Run locally: `bun run docs:dev`
- Build: `bun run docs:build`
- Internal planning docs: `planning/`

## Commands

- `chkit init`
- `chkit generate [--name <migration-name>] [--migration-id <id>] [--config <path>] [--dryrun] [--json]`
- `chkit pull [--out-file <path>] [--database <db>] [--dryrun] [--force] [--config <path>] [--json]`
- `chkit codegen [--check] [--out-file <path>] [--emit-zod] [--no-emit-zod] [--emit-ingest] [--no-emit-ingest] [--ingest-out-file <path>] [--bigint-mode <string|bigint>] [--include-views] [--config <path>] [--json]`
- `chkit migrate [--config <path>] [--apply|--execute] [--allow-destructive] [--json]`
- `chkit status [--config <path>] [--json]`
- `chkit drift [--config <path>] [--json]`
- `chkit check [--config <path>] [--strict] [--json]`
- `chkit plugin [<plugin-name> [<command> ...]] [--config <path>] [--json]`
- `chkit version`

## Global Flags

- `--config <path>`: config file path (default: `clickhouse.config.ts`)
- `--json`: machine-readable command output

## What Each Command Does

### `chkit init`

Creates starter files if missing:

- `clickhouse.config.ts`
- `src/db/schema/example.ts`

### `chkit generate`

- Loads schema files from `config.schema`
- Validates definitions
- Diffs against `meta/snapshot.json`
- Writes migration SQL + updates snapshot (unless `--dryrun`)
- Runs `codegen` plugin automatically when configured with `runOnGenerate: true` (default)

### `chkit codegen`

- Optional manual command to generate TypeScript types and ingestion functions from schema definitions
- `--check` verifies generated output is up-to-date (no write)
- Supports optional Zod emission (`--emit-zod`) and ingestion function emission (`--emit-ingest`)
- Returns non-zero on stale/missing artifacts in check mode

### `chkit plugin pull schema`

- Pulls live ClickHouse table metadata and writes a local chkit schema file
- Supports `--out-file`, repeated `--database`, `--dryrun`, and `--force`
- Shortcut: `chkit pull ...` (equivalent to `chkit plugin pull schema ...`)

### `chkit migrate`

- Always prints pending migration plan first
- Prompts for confirmation when run without `--apply` or `--execute`
- Applies pending migrations immediately when run with `--apply` (or alias `--execute`)
- Maintains `meta/journal.json`
- Blocks execution when:
  - applied-file checksums mismatch
  - pending migration includes destructive operations and `--allow-destructive` is not set in non-interactive mode (interactive mode prompts for explicit confirmation)

### `chkit status`

Shows migration counts and checksum mismatch status.

### `chkit drift`

Compares live ClickHouse objects to snapshot expectations and reports drift details.

Drift reason codes you may see:

- object-level: `missing_object`, `extra_object`, `kind_mismatch`
- table-level: `missing_column`, `extra_column`, `changed_column`, `setting_mismatch`, `index_mismatch`, `ttl_mismatch`, `engine_mismatch`, `primary_key_mismatch`, `order_by_mismatch`, `unique_key_mismatch`, `partition_by_mismatch`, `projection_mismatch`

### `chkit check`

CI gate command. Evaluates:

- pending migrations
- checksum mismatches
- schema drift
- plugin checks (including `codegen` when configured)

Returns non-zero when enabled checks fail.

## Config (`clickhouse.config.ts`)

```ts
import { defineConfig } from '@chkit/core'
import { pull } from '@chkit/plugin-pull'
import { codegen } from '@chkit/plugin-codegen'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  migrationsDir: './chkit/migrations',
  metaDir: './chkit/meta',
  plugins: [
    pull({
      outFile: './src/db/schema/pulled.ts',
    }),

    // Typed registration (recommended):
    codegen({
      outFile: './src/generated/chkit-types.ts',
      emitZod: false,
      emitIngest: false,
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

For typed config registration, plugin packages can export helpers that return inline registrations (for example `codegen(...)` from `@chkit/plugin-codegen`).

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
  - `chkit plugin`
  - `chkit plugin <plugin-name>`
  - `chkit plugin <plugin-name> <command> [args...]`

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
