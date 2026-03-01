# chkit

ClickHouse schema management and migration toolkit for TypeScript.

## Project Structure

This is a monorepo managed with Bun workspaces and Turborepo.

### Main Package (Entry Point)

**`chkit`** (`packages/cli`) is the CLI and the primary distribution package. Its README is the main README shown on npm. All other packages exist to support the CLI or extend it via plugins. When users install chkit, they run `bun add -d chkit`.

### Packages

| Package | npm name | Role |
|---------|----------|------|
| `packages/cli` | `chkit` | **CLI binary and main entry point** |
| `packages/core` | `@chkit/core` | Schema DSL, config, diff engine, migration planner |
| `packages/clickhouse` | `@chkit/clickhouse` | ClickHouse client wrapper (internal) |
| `packages/codegen` | `@chkit/codegen` | Migration artifact generator (internal) |
| `packages/plugin-codegen` | `@chkit/plugin-codegen` | Plugin: TypeScript type + Zod schema generation |
| `packages/plugin-pull` | `@chkit/plugin-pull` | Plugin: introspect live ClickHouse into schema files |
| `packages/plugin-backfill` | `@chkit/plugin-backfill` | Plugin: time-windowed data backfill with checkpoints |

### Documentation

- Website: https://chkit.obsessiondb.com
- GitHub: https://github.com/obsessiondb/chkit

## Key Conventions

- All packages publish to npm with `homepage: "https://chkit.obsessiondb.com"` and `repository` pointing to the monorepo with the correct `directory`.
- Every package README links to the `chkit` CLI on npm as the entry point and to the documentation website.
- Internal packages (`@chkit/clickhouse`, `@chkit/codegen`) are not meant to be installed directly by users.
- Plugins extend the CLI and are registered in `clickhouse.config.ts` via the `plugins` array.

## CLI Commands

`init`, `generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`, `plugin`

All commands support `--json` for machine-readable output and `--config <path>` for custom config files.

## Development

```bash
bun install          # install dependencies
bun run build        # build all packages
bun run test         # run all tests
bun run typecheck    # type-check all packages
bun run lint         # lint all packages
```

## Testing

### E2E Tests

E2E tests run against a live ClickHouse Cloud instance. They require these environment variables (hard-fail, never skip):

- `CLICKHOUSE_HOST` or `CLICKHOUSE_URL` — ClickHouse endpoint
- `CLICKHOUSE_PASSWORD` — authentication
- `CLICKHOUSE_DB` — target database (optional, defaults to `default`)

Shared test utilities live in `packages/cli/src/e2e-testkit.ts`. Use them in CLI E2E tests. The `plugin-pull` test keeps minimal inline utilities because it's in a separate package.

Key conventions:

- **Hard-fail on missing env** — never `test.skip()` or silently pass when credentials are absent.
- **State-based polling** — use `waitForTable()`, `waitForView()`, `waitForColumn()` instead of blind retry loops. ClickHouse Cloud DDL is eventually consistent.
- **Unique naming** — every test run uses `createPrefix()` / `createJournalTableName()` with timestamps and random suffixes to avoid collisions.
- **Structured diagnostics** — use `formatTestDiagnostic()` for CLI failure messages.

### CI

CI is split into two jobs:

- **verify** — lint, typecheck, build (no secrets needed, fast feedback)
- **test** — all tests with ClickHouse secrets (runs after verify)

`turbo.json` passes through `CLICKHOUSE_DB`, `CLICKHOUSE_HOST`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_URL`, and `CLICKHOUSE_USER` to the `test` task.

## Release

Uses changesets. Run `bun run changeset` to create a changeset, then `bun run version-packages` to bump versions.
