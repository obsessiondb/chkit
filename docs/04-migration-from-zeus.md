# Migration Plan from Zeus `clickhouse-infra`

## Source Context
Legacy source: `/Users/marc/Workspace/zeus/packages/clickhouse-infra`

Key observations from analysis:
1. script-driven operational CLI (`scripts/ch-*.ts`).
2. strong schema logic exists but coupled to monorepo dependencies.
3. substantial duplication across commands.
4. mixed export patterns (table-only vs array legacy) and migration leftovers.
5. advanced workflows (backfill/propagation/rename) valuable but high risk for early core.

## Migration Strategy
Use strangler pattern:
1. port stable, generic primitives first into CHX core.
2. leave domain-specific workflows behind initially.
3. reintroduce advanced features via plugins only after core stabilization.

## Capability Mapping

### Legacy -> CHX Core (Early)
1. table/view/mv definition model.
2. SQL generation for creates.
3. schema snapshot and basic diffs.
4. migration apply + status.

### Legacy -> CHX Core (Later)
1. schema diff richness (settings/TTL/indexes/order-by extension logic).
2. drift detection from ClickHouse introspection.
3. rename assist (guarded flow).

### Legacy -> CHX Plugin (Deferred)
1. dependency graph visualization (`print-graph.ts`).
2. backfill commands:
   - `ch-backfill-mv`
   - `ch-backfill-mv-partition`
   - `ch-backfill-propagate`
3. specialized copy/reingest scripts.
4. custom chain/business-specific scripts.

## Step-by-Step Extraction Plan

### Step 1: Isolate Portable Domain Types
1. extract table/view/mv definitions into `@chx/core` model.
2. remove references to monorepo-internal libs (`pipe-shared`, `shared-util`).
3. freeze stable type interfaces.

### Step 2: Port SQL Rendering
1. port create SQL generation with deterministic ordering.
2. port alter SQL operations gradually via operation model.
3. add unit tests with legacy fixtures to verify parity.

### Step 3: Build Snapshot + Diff Base
1. define snapshot format v1.
2. implement basic diff ops.
3. compare generated SQL against known legacy outputs for representative schemas.

### Step 4: Implement CLI Core Loop
1. `init`, `generate`, `status`, `migrate`.
2. ensure no dependency on legacy export shape assumptions.
3. ensure config and schema loading work in any project.

### Step 5: Add Adapter Introspection
1. port selected schema reader logic (`system.tables`, `system.columns`, indexes).
2. produce drift reports.
3. add integration tests against ClickHouse.

### Step 6: Add Safety Features
1. destructive op gating.
2. plan and JSON output.
3. explicit allow flags for dangerous operations.

### Step 7: Pluginize Advanced Legacy Workflows
1. dependency graph plugin.
2. backfill plugin with explicit operational warnings.
3. optional typegen plugin.

## Legacy Code Reuse Recommendations

### Safe to Reuse with Refactor
1. schema comparison concepts from `schema-diff.ts`.
2. dependency graph concepts from `dependency-graph.ts`.
3. SQL rendering ideas from `change-sql.ts`.

### Reuse with Caution
1. rename detection (fuzzy matching can misfire).
2. partition-aware backfill query rewriting.
3. engine/casing assumptions in drop logic.

### Avoid Direct Lift
1. scripts with side effects on import.
2. scripts tightly coupled to existing package wiring.
3. ad-hoc command arg parsing duplicated per script.

## Suggested Backlog for Migration Work

### Epic A: Core Parity Baseline
1. port DSL.
2. port create SQL.
3. port snapshot format.
4. test parity fixtures.

### Epic B: CLI Migration Loop
1. generate pipeline.
2. migrate execution.
3. status/journal.

### Epic C: Drift/Alter Semantics
1. introspection adapter.
2. alter operation planner.
3. risk classification.

### Epic D: Advanced Plugin Track
1. dependency graph plugin.
2. backfill plugin MVP.
3. typegen plugin.

## Acceptance Criteria for Legacy Retirement
1. At least one real project can fully replace old `ch-create/ch-sync/ch-change` path.
2. Migration outputs are deterministic and reviewed in PR.
3. No blocker workflows still require old scripts for standard schema evolution.
4. Advanced operational workflows have either plugin replacement or explicit runbook fallback.

## Cutover Plan

### Stage 1
1. Run CHX in shadow mode to generate plans while old scripts still apply.
2. Compare planned SQL for divergence.

### Stage 2
1. Use CHX for dev/staging migration generation.
2. Keep prod apply with old tooling as fallback.

### Stage 3
1. Use CHX for full environments.
2. Keep rollback playbook for 1 release cycle.

### Stage 4
1. Archive old scripts.
2. Keep reference docs and fixtures only.

## Data and Operational Safety During Migration
1. Never run destructive migrations automatically in first rollout.
2. Require manual approval gate for drops/modifies in production.
3. Validate migration SQL in staging against production-like data volume where possible.

## Documentation to Preserve from Legacy Repo
1. backfill operational docs.
2. schema design conventions.
3. chain-specific modeling notes.
4. known ClickHouse edge cases encountered historically.
