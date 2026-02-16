# chkit Internal Structure

This document is for contributors. The root `README.md` is user-facing.

## Monorepo Packages

- `packages/core`: schema model, DSL, canonicalization, validation, SQL rendering, migration planning.
- `packages/clickhouse`: ClickHouse executor and schema introspection/parsing.
- `packages/codegen`: migration artifact + snapshot generation.
- `packages/cli`: command-line app (`chkit`).

## Core Module Layout

- `packages/core/src/model.ts`: shared types + DSL creators (`table`, `view`, `schema`) + config types.
- `packages/core/src/canonical.ts`: definition normalization and module collection.
- `packages/core/src/validate.ts`: schema validation and typed validation errors.
- `packages/core/src/sql.ts`: `CREATE` and `ALTER` SQL rendering.
- `packages/core/src/planner.ts`: schema diff planner (`planDiff`) and risk summary.
- `packages/core/src/snapshot.ts`: snapshot creation helper.
- `packages/core/src/index.ts`: public barrel exports.

## CLI Module Layout

- `packages/cli/src/bin/chkit.ts`: stricli app wiring and route/flag mapping.
- `packages/cli/src/bin/lib.ts`: shared CLI runtime helpers (config, dirs, json envelope, journal/snapshot helpers).
- `packages/cli/src/bin/commands/init.ts`: `chkit init`.
- `packages/cli/src/bin/commands/generate.ts`: `chkit generate`.
- `packages/cli/src/bin/commands/migrate.ts`: `chkit migrate`.
- `packages/cli/src/bin/commands/status.ts`: `chkit status`.
- `packages/cli/src/bin/commands/drift.ts`: `chkit drift` and drift payload builder.
- `packages/cli/src/bin/commands/check.ts`: `chkit check`.
- `packages/cli/src/drift.ts`: pure drift comparison logic + reason summaries.

## Test Layout

- `packages/core/src/index.test.ts`: core API + planner behavior.
- `packages/clickhouse/src/index.test.ts`: parser and adapter smoke tests.
- `packages/codegen/src/index.test.ts`: artifact generation behavior.
- `packages/cli/src/index.test.ts`: CLI command-flow fixture tests.
- `packages/cli/src/migration-scenario.test.ts`: staged migration scenario (fixture-based CLI integration).
- `packages/cli/src/drift.test.ts`: pure drift comparator tests.
- `packages/cli/src/drift.e2e.test.ts`: live drift scenario against ClickHouse when env is configured.
- `packages/cli/src/clickhouse-live.e2e.test.ts`: live end-to-end CLI migration/check flows when env is configured.

## Command Data Flow (High Level)

1. Load config (`clickhouse.config.ts`).
2. Resolve directories (`outDir`, `migrationsDir`, `metaDir`).
3. For `generate`: load schema modules -> canonicalize/validate -> plan diff -> write artifacts.
4. For `migrate`: load pending + journal -> safety gates -> execute SQL -> update journal.
5. For `drift/check`: load snapshot + introspect live ClickHouse -> compare and summarize.

## Stability Rules

- JSON payload envelope is `command` + `schemaVersion`.
- Stable payload keys are documented in `planning/07-json-output-contract.md`.
- Backward-incompatible JSON shape changes require a schema version bump.
