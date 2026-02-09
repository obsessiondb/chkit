# CHX Product Scope

## Vision
CHX is a standalone, framework-agnostic ClickHouse schema and migrations toolkit for TypeScript projects, inspired by Drizzle's developer ergonomics:
- schema defined in TypeScript
- deterministic SQL migration generation
- safe migration application and status tracking
- extensible adapter/plugin architecture for advanced ClickHouse workflows

## Product Goals
1. Make ClickHouse schema management reproducible, versioned, and reviewable.
2. Work across many projects without monorepo-specific dependencies.
3. Provide safe defaults for production environments.
4. Support both simple and advanced ClickHouse deployments.
5. Offer an extension model for domain-specific workflows (backfill, dependency graph, typegen, data QA).

## Non-Goals (Initial)
1. No GUI/studio in MVP.
2. No full SQL parser-based reverse engineering in MVP.
3. No automatic conflict resolution for arbitrary manual DB drift in MVP.
4. No non-ClickHouse database support in initial releases.

## Primary Users
1. Data platform engineers managing ClickHouse DDL.
2. Backend engineers who need reproducible table/view/MV migrations.
3. Analytics engineers who need controlled schema evolution.
4. Teams moving from custom infra scripts to a reusable toolchain.

## Core Use Cases
1. Initialize a project and define schema in TypeScript.
2. Generate SQL migrations from schema state changes.
3. Apply pending migrations in dev/staging/prod.
4. Inspect migration status and drift.
5. Keep migration history and metadata auditable.

## Scope by Capability

### 1. Schema Definition DSL
- `table`, `view`, `materializedView` definitions
- column types, nullability, defaults, comments
- PK/ORDER BY/PARTITION BY/TTL/settings/indexes
- distributed/cluster metadata support (phase-gated)

### 2. Snapshot and Diff Engine
- canonical schema snapshot generation
- deterministic diff from previous snapshot -> next schema
- migration operations:
  - create/drop table/view/mv
  - add/modify/drop column
  - add/modify/remove settings
  - TTL updates
  - index add/drop/materialize
- risk classification per operation

### 3. Migration File System
- timestamped SQL files (`migrations/`)
- metadata snapshots (`meta/snapshot.json`)
- apply journal (`meta/journal.json` in early versions; DB table in later phase)
- immutable migration history

### 4. CLI UX
- `chx init`
- `chx generate`
- `chx migrate`
- `chx status`
- `chx check` / `chx drift` (phase 2)
- `chx pull` (phase 3, optional)

### 5. ClickHouse Execution
- execute SQL with robust error reporting
- migration transaction model suited to ClickHouse semantics
- environment-aware connection loading
- query settings support (timeouts, safety flags)

### 6. Safety and Governance
- dry-run/plan mode by default for risky operations
- prompts for destructive actions
- machine-readable plan output for CI
- lint/validation mode for schema definitions

### 7. Plugin/Extension System
- plugin hooks for custom commands and codegen
- optional plugins:
  - dependency graph
  - MV backfill orchestrator
  - type generation (Zod/TS)
  - cluster-specific policies

## Functionality Matrix

### MVP (v0.1-v0.2)
1. TypeScript schema DSL.
2. Snapshot generation.
3. Deterministic migration SQL generation.
4. Migration apply and status.
5. Minimal ClickHouse adapter.
6. Local metadata journal.
7. Basic docs and examples.

### Beta (v0.3-v0.6)
1. Rich diff support (TTL/settings/indexes/order-by extension semantics).
2. Safer destructive flow with explicit flags.
3. Drift detection command.
4. CI-friendly JSON output modes.
5. Better error classes and recovery guidance.
6. Initial plugin API.

### GA (v1.0)
1. Stable migration format/versioning contract.
2. Full CLI stability and backward compatibility policy.
3. Plugin architecture marked stable.
4. Advanced ClickHouse features (cluster/distributed policies, rename flows).
5. Production hardening and reliability SLOs.

## Out-of-Scope but Planned Later
1. Web Studio/inspection UI.
2. Migration squashing workflows.
3. Reverse migration generation guarantees.
4. Auto-tuning suggestions for ClickHouse settings.
5. Multi-database support.

## Success Metrics
1. Time from schema edit -> reviewed migration under 2 minutes.
2. Zero unexpected destructive statements in default workflow.
3. Deterministic output: same input => byte-identical migration plan.
4. At least 3 external projects successfully onboarded before v1.0.
5. <5% migration apply failure rate due to tool errors in beta projects.

## Risks
1. ClickHouse DDL edge cases are broad and engine-specific.
2. Distributed table behavior differs by cluster and version.
3. Rename detection and safe automations can produce false positives.
4. Backfill orchestration is operationally risky if shipped too early in core.
5. Plugin API can become unstable without strict version contracts.

## Product Principles
1. Determinism over convenience.
2. Explicitness over magic.
3. Safe-by-default execution.
4. Extensibility without coupling core to one organization's workflows.
5. Ergonomic CLI output for humans, structured output for automation.
