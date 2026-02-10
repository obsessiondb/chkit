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
bun run chx migrate --plan
bun run chx migrate --execute
bun run chx status
bun run chx check
```

## Commands

- `chx init`
- `chx generate [--name <migration-name>] [--migration-id <id>] [--config <path>] [--plan] [--json]`
- `chx migrate [--config <path>] [--execute] [--allow-destructive] [--plan] [--json]`
- `chx status [--config <path>] [--json]`
- `chx drift [--config <path>] [--json]`
- `chx check [--config <path>] [--strict] [--json]`
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
- Writes migration SQL + updates snapshot (unless `--plan`)

### `chx migrate`

- Applies pending migrations (with `--execute`)
- Maintains `meta/journal.json`
- Blocks execution when:
  - applied-file checksums mismatch
  - pending migration includes dangerous operations and `--allow-destructive` is not set

### `chx status`

Shows migration counts and checksum mismatch status.

### `chx drift`

Compares live ClickHouse objects to snapshot expectations and reports drift details.

### `chx check`

CI gate command. Evaluates:

- pending migrations
- checksum mismatches
- schema drift

Returns non-zero when enabled checks fail.

## Config (`clickhouse.config.ts`)

```ts
export default {
  schema: './src/db/schema/**/*.ts',
  outDir: './chx',
  migrationsDir: './chx/migrations',
  metaDir: './chx/meta',

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
}
```

## Output Artifacts

Under `metaDir`:

- `snapshot.json`: canonical schema snapshot
- `journal.json`: applied migration journal

Under `migrationsDir`:

- `YYYYMMDDHHMMSS_<name>.sql`

## JSON Output Contract

- Contract document: `docs/07-json-output-contract.md`

## Contributor Docs

- Internal architecture and repository structure: `docs/08-internal-structure.md`
- Planning docs index: `docs/README.md`
