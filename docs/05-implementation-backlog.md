# CHX Implementation Backlog (Detailed)

## How to Use This Backlog
1. Treat each item as an issue candidate.
2. Keep PRs small and vertically sliced.
3. Prioritize by dependency order and risk.

## Core Package Backlog (`@chkit/core`)

### Schema and Validation
1. Add richer column type helpers and aliases.
2. Add runtime validation for duplicate object names.
3. Add validation for PK/orderBy referencing missing columns.
4. Add validation for unsupported combinations (engine + settings).
5. Add schema linting diagnostics with line/file context.

### Canonicalization
1. Canonical sort implementation for all object kinds.
2. Identifier normalization strategy.
3. Expression normalization utility.
4. Snapshot deterministic serializer.

### Diff Planner
1. Compare object existence and kind changes.
2. Table-level changes:
   - add/drop/modify columns
   - PK/orderBy rules
   - TTL rules
   - settings rules
   - indexes rules
3. View/MV change handling strategy.
4. Operation dependency ordering.
5. Risk classification per op.

### SQL Renderer
1. create statements for all object kinds.
2. alter statements per operation type.
3. drop statements with safety wrappers.
4. renderer options for cluster/distributed support.

### Testing
1. unit tests per planner operation.
2. golden tests for SQL output determinism.
3. property tests for normalization idempotency.

## ClickHouse Adapter Backlog (`@chkit/clickhouse`)

### Connection and Execution
1. configurable clickhouse settings per command.
2. standard executor with typed result helpers.
3. SQL execution report format.

### Introspection
1. tables metadata reader.
2. columns metadata reader.
3. skip index metadata reader.
4. settings extraction strategy.
5. TTL/comment extraction strategy.

### Drift Mapping
1. map introspected tables to canonical model.
2. compare introspected model with snapshot.
3. produce drift diff report.

### Resilience
1. transient error classification and retry policy.
2. clear error mapping for auth/network/DDL errors.

### Testing
1. integration tests with ephemeral ClickHouse.
2. compatibility tests across selected ClickHouse versions.

## Codegen Backlog (`@chkit/codegen`)

### Migration Files
1. migration file header metadata:
   - version
   - generated timestamp
   - command version
2. deterministic file naming controls.
3. multi-file splitting option for large plans (optional).

### Snapshot and Journal
1. snapshot versioning field and upgrader hook.
2. journal durability behavior.
3. partial apply recording strategy.

### Reports
1. plan JSON output format.
2. apply result JSON format.
3. CI summary markdown output (optional).

### Testing
1. fs-level tests (atomic writes, idempotent reads).
2. corrupted journal/snapshot recovery tests.

## CLI Backlog (`@chkit/cli`)

### Command UX
1. robust argument parser upgrade (strict flags, typed options).
2. interactive prompts for dangerous actions.
3. `--json` and `--quiet` modes.
4. concise and verbose output modes.

### Commands
1. `init` improvements:
   - optional template variants
   - idempotent updates
2. `generate` improvements:
   - explicit plan print
   - danger summary
3. `migrate` improvements:
   - per-migration timing
   - partial failure guidance
4. `status` improvements:
   - stale snapshot warnings
5. add `drift` command (phase 2).
6. add `check` command for CI policy enforcement.

### Config
1. config schema validation with actionable errors.
2. support `clickhouse.config.ts` and `.mjs/.js` variants.
3. env override strategy.

### Plugin Runtime
1. plugin registration API.
2. plugin lifecycle hooks.
3. plugin command namespace support.

### Testing
1. command integration tests with fixture projects.
2. golden output tests.
3. JSON output contract tests.

## Plugin Backlog (Post-Core)

### Dependency Intelligence Plugin (Deferred Optional Module)
1. build dependency index from schema definitions and MV targets.
2. add dependency risk findings and policy gates (`generate`/`check`/optional `migrate`).
3. add cycle detection and unresolved-reference warnings.
4. defer graph export/visualization from initial version.

### Backfill Plugin
1. MV destination truncate+insert workflow.
2. partition-aware mode.
3. propagation mode via dependency graph.
4. dry-run and approval gates.
5. explicit operational safeguards.

### Typegen Plugin
1. generate zod and TS types from schema.
2. safer handling for large integer ClickHouse types.
3. support output customization.

### Rename Heuristics Plugin (Very Low Priority)
1. extract heuristic rename suggestion detection/scoring from core into an optional plugin.
2. keep explicit rename intent and validation in core for deterministic behavior.
3. provide suggestion-only mode first; interactive confirmation flow remains opt-in.
4. defer implementation until recurring demand or maintenance pressure justifies extraction.

## Cross-Cutting Backlog

### Quality
1. coverage thresholds.
2. regression test fixture corpus.
3. performance benchmark suite for diff/generate.

### Documentation
1. complete command reference.
2. config reference.
3. migration semantics reference.
4. operations/safety runbook.

### DevEx
1. example apps repo folder.
2. starter templates.
3. upgrade guides.

## Priority Order (Suggested)
1. core canonicalization + diff stability.
2. migration loop reliability (`generate/migrate/status`).
3. drift and safety policies.
4. advanced ClickHouse semantics.
5. plugin system and advanced workflows.

## Potential Breaking Change Triggers
1. snapshot format changes.
2. operation model changes.
3. SQL rendering defaults changes.
4. CLI command semantics changes.

## Issue Starter Labels (Suggested)
1. `phase:0` ... `phase:5`
2. `pkg:core`
3. `pkg:clickhouse`
4. `pkg:codegen`
5. `pkg:cli`
6. `plugin`
7. `good-first-issue`
8. `breaking-change`
