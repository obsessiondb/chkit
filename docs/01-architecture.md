# CHX Architecture

## Architectural Overview
CHX uses a layered architecture:
1. `@chx/core`: pure domain logic (definitions, canonicalization, diff planning, SQL rendering contracts).
2. `@chx/clickhouse`: ClickHouse runtime adapter (introspection + execution).
3. `@chx/codegen`: filesystem artifacts (snapshots, migration files, plan outputs).
4. `@chx/cli`: command orchestration, prompts, config loading, UX.
5. plugins: optional capabilities that hook into CLI and planning lifecycle.

## Design Constraints
1. No dependency on private monorepo packages.
2. Core must remain runtime-agnostic and testable without a DB.
3. CLI should be thin orchestration, not business logic.
4. All generated artifacts must be deterministic.
5. Adapter boundaries must enable integration tests against real ClickHouse.

## Package Responsibilities

### `@chx/core`
- schema DSL and types
- canonical model normalization
- diff planner
- risk classifier
- SQL operation renderer interfaces
- migration operation graph

#### Proposed Internal Modules
1. `schema/`
   - DSL builders (`table`, `view`, `materializedView`)
   - type definitions
   - validators
2. `normalize/`
   - canonical sorting
   - default expansion
   - identifier normalization
3. `snapshot/`
   - snapshot model
   - serialization/deserialization
4. `diff/`
   - compare old/new canonical schema
   - create operations
5. `plan/`
   - order operations
   - classify risk levels
6. `sql/`
   - operation -> SQL string
   - SQL generation options
7. `errors/`
   - typed error hierarchy

### `@chx/clickhouse`
- execute SQL statements
- introspect DB metadata (tables/columns/settings/indexes)
- detect drift against expected schema
- adapter options (timeouts, readonly modes, custom settings)

#### Proposed Internal Modules
1. `client/` (connection factory)
2. `execute/` (safe execution wrappers)
3. `introspect/` (system tables readers)
4. `drift/` (db schema -> core model mapping)
5. `errors/`

### `@chx/codegen`
- write migration files
- write snapshot and journals
- support stable naming conventions
- output plan in machine-readable JSON

#### Proposed Internal Modules
1. `files/` (atomic writes, lock handling)
2. `migration/` (file naming, headers, SQL bundle writing)
3. `journal/` (read/write applied state)
4. `snapshot/` (persist/load snapshots)
5. `export/` (plan/report serialization)

### `@chx/cli`
- command parsing and routing
- config discovery and loading
- schema module discovery
- command UX, prompts, tables, logs
- plugin command registration

#### Proposed Internal Modules
1. `config/` (load/validate config)
2. `loader/` (schema file globbing + module loading)
3. `commands/` (`init`, `generate`, `migrate`, `status`, etc.)
4. `ui/` (print formatting, interactive prompts)
5. `output/` (JSON output mode)
6. `plugins/` (plugin runtime and hooks)

## Data Flow

### Generate Flow
1. Load config.
2. Discover schema files.
3. Collect + validate schema definitions.
4. Normalize to canonical schema.
5. Load previous snapshot.
6. Diff previous -> current.
7. Build ordered migration plan.
8. Render SQL operations.
9. Write migration file and new snapshot.
10. Print summary and risk flags.

### Migrate Flow
1. Load config.
2. Load migration journal.
3. List migration files.
4. Compute pending migrations.
5. If plan mode: print pending and stop.
6. If execute mode: apply sequentially with error boundaries.
7. Update journal after each successful migration (or transaction group where possible).
8. Emit apply report.

### Status Flow
1. Load journal and migration directory.
2. Compute total/applied/pending.
3. Optionally compare DB introspection to snapshot (phase 2).
4. Emit human and/or JSON report.

## Canonical Schema Model
Canonicalization is critical to avoid noisy diffs.

### Canonical Rules
1. Stable sort by object kind + `database.name`.
2. Stable sort columns by declaration order unless explicitly configured.
3. Normalize SQL-like strings (trim, whitespace collapse where safe).
4. Normalize defaults, nullable wrappers, and aliases.
5. Exclude transient fields from snapshots.

## Diff and Operation Model

### Operation Types (Target)
1. `create_table`
2. `drop_table`
3. `alter_table_add_column`
4. `alter_table_modify_column`
5. `alter_table_drop_column`
6. `alter_table_modify_ttl`
7. `alter_table_modify_setting`
8. `alter_table_reset_setting`
9. `alter_table_add_index`
10. `alter_table_drop_index`
11. `alter_table_materialize_index`
12. `create_view`
13. `drop_view`
14. `create_materialized_view`
15. `drop_materialized_view`
16. `rename_table` (phase 3, guarded)

### Risk Levels
1. `safe`: additive changes.
2. `caution`: potentially expensive mutations.
3. `danger`: destructive or data-loss risk.

## SQL Rendering Strategy
1. Renderer consumes operation model, not raw schema objects.
2. Separate rendering from planning for testability.
3. Ensure SQL output ordering is deterministic.
4. Engine-specific clauses are validated before render.

## Config Model (Target)
```ts
export default {
  schema: './src/db/schema/**/*.ts',
  migrationsDir: './chx/migrations',
  metaDir: './chx/meta',
  clickhouse: {
    url: 'http://localhost:8123',
    username: 'default',
    password: '',
    database: 'default',
    settings: {
      max_execution_time: 60,
    },
  },
  safety: {
    requireConfirmOnDanger: true,
    allowDestructive: false,
  },
  output: {
    json: false,
  },
}
```

## Plugin Architecture (Target)

### Plugin Types
1. command plugins
2. planning hooks
3. SQL post-processing hooks
4. report/output hooks

### Hook Contract (Example)
1. `onConfigLoaded(config)`
2. `onSchemaLoaded(definitions)`
3. `onPlanCreated(plan)`
4. `onBeforeApply(migration)`
5. `onAfterApply(result)`

## Error Handling Model
1. Typed errors with codes and remediation hints.
2. Distinguish user/config errors from system/runtime errors.
3. Exit codes standardized for CI usage.

## Testing Strategy by Layer

### Core
- unit tests for normalization and diff
- snapshot tests for deterministic SQL output
- property tests for ordering/idempotency

### ClickHouse Adapter
- integration tests against ephemeral ClickHouse container
- failure-mode tests (connection issues, bad SQL, permission errors)

### Codegen
- filesystem tests for migration/journal behavior
- atomic write and recovery behavior tests

### CLI
- command smoke tests
- golden output tests
- JSON output schema tests

## Versioning and Compatibility
1. SemVer for packages.
2. Migration file format version embedded in metadata.
3. Backward compatibility policy for CLI commands and config keys.
4. Feature flags for breaking behavior during beta.

## Observability and Telemetry (Optional)
1. Structured logs in verbose mode.
2. Timing metrics for generation and migration apply.
3. Optional anonymous usage analytics (opt-in only).

## Security Considerations
1. Never log secrets by default.
2. Redact connection credentials in errors.
3. Validate SQL inputs generated by tool; do not execute arbitrary user text by default path.
4. Strict allowlist for automated destructive operations.
