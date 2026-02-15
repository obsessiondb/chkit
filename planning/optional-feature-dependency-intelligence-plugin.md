# Optional Feature: Dependency Intelligence Plugin

## Status
- Deferred optional module.
- Not part of Phase 4 required deliverables.
- Re-evaluate after plugin runtime and typegen plugin are stable.

## Problem
CHX currently provides deterministic operation ordering and risk tagging, but it does not model dependency impact deeply across tables, views, and materialized views. Teams with heavier derived-data pipelines need stronger preflight safety signals and dependency-aware execution guidance.

## Goals
1. Add dependency-aware safety checks without coupling core to advanced policy logic.
2. Provide operationally useful outputs (gates, summaries, ordering hints) with no visualization requirement.
3. Reuse plugin lifecycle and command namespace introduced in Phase 4.
4. Keep behavior deterministic and CI-friendly.

## Non-Goals (Initial Version)
1. No graph export output (no Mermaid, no visual renderer).
2. No automatic destructive remediation.
3. No SQL lineage parser for arbitrary complex queries in v1.
4. No direct mutation of core planner internals.

## Why This Stays Optional
1. Dependency policies are environment-specific (strict in production, relaxed in dev).
2. Inference quality from SQL text can vary and may need tuned heuristics.
3. Some projects have simple schemas and do not benefit enough to justify default runtime overhead.

## Core vs Plugin Responsibility
### Keep in Core
1. Deterministic baseline migration operation ordering.
2. Basic risk tagging and destructive gates.

### Put in Plugin
1. Extended dependency index construction.
2. Dependency-aware policy checks and blocking rules.
3. Blast-radius summaries and change impact reporting.
4. Optional dependency-aware reorder suggestions.

## Functional Scope (v1)
1. Build dependency index from schema definitions:
   - `view -> referenced objects` (best-effort inference from `as` SQL).
   - `materialized_view -> destination table`.
   - `materialized_view -> referenced objects` (best-effort inference from `as` SQL).
2. Evaluate migration plans against index:
   - detect changed objects with downstream dependents.
   - detect likely broken dependency chains.
3. Produce structured findings:
   - severity (`info`, `warn`, `error`).
   - reason code (stable string).
   - subject object.
   - dependent objects.
   - recommendation.
4. Enforce configurable policy gates:
   - fail on `error` findings during `generate --dryrun` and `check`.
   - optional fail during `migrate --apply`.

## Proposed Plugin Commands
1. `chx plugin deps check`
   - run dependency analysis against current schema and latest plan/snapshot.
2. `chx plugin deps impact --object <db.name>`
   - list upstream/downstream impact for one object.
3. `chx plugin deps doctor`
   - print actionable remediation guidance for findings.

## Hook Usage Plan
1. `onSchemaLoaded`
   - build and cache dependency index in plugin memory.
2. `onPlanCreated`
   - evaluate plan against dependency index and attach findings to plugin state.
3. `onBeforeApply`
   - enforce policy gates before executing statements.
4. `onConfigLoaded`
   - validate plugin config and policy defaults.

## Configuration Model (Draft)
```ts
plugins: [
  {
    resolve: './plugins/dependency-intelligence.ts',
    options: {
      policy: {
        failOnError: true,
        failOnWarn: false,
        enforceOnMigrate: true,
      },
      inference: {
        enableSqlReferenceGuessing: true,
      },
    },
  },
]
```

## Finding Codes (Draft)
1. `dependent_drop_risk`
2. `dependent_recreate_risk`
3. `mv_destination_change_requires_backfill`
4. `dependency_cycle_detected`
5. `unresolved_reference_in_view`

## Data Model (Draft)
```ts
type DepNodeKind = 'table' | 'view' | 'materialized_view'

interface DepNode {
  id: string // `${kind}:${database}.${name}`
  kind: DepNodeKind
  database: string
  name: string
}

interface DepEdge {
  from: string
  to: string
  reason: 'select_reference' | 'mv_to_target'
  confidence: 'high' | 'medium'
}
```

## Algorithm Outline
1. Normalize schema definitions using canonical order.
2. Register all objects as nodes.
3. Add deterministic high-confidence edges:
   - MV to destination table.
4. Add medium-confidence inferred edges from SQL references in view/MV `AS` clauses.
5. Build forward and reverse adjacency maps.
6. During plan evaluation, map each operation key to object node.
7. Traverse reverse dependencies for changed/dropped nodes.
8. Emit findings sorted by severity, then object key.

## Failure and Safety Behavior
1. Plugin errors must surface as plugin-scoped errors with clear remediation.
2. When policy blocks execution, output machine-readable findings and non-zero exit code.
3. If inference fails for some SQL, emit warning findings instead of silent skip.

## Testing Strategy
1. Unit tests:
   - node/edge construction.
   - cycle detection.
   - finding generation for drop/recreate scenarios.
2. CLI integration tests:
   - `generate --dryrun` blocked by configured policy.
   - `migrate --apply` blocked/allowed based on policy.
3. JSON contract tests:
   - stable finding keys and reason codes.
4. Regression fixtures:
   - simple chain (`table -> view -> mv`).
   - fan-out dependencies.
   - cross-database dependencies.

## Rollout Plan
1. Milestone A: internal plugin skeleton with `deps check`.
2. Milestone B: hook-based policy enforcement (`generate`, `migrate`).
3. Milestone C: CI adoption in one real project.
4. Milestone D: optional promotion of minimal checks into core if universally needed.

## Exit Criteria
1. Plugin can detect and gate at least two high-risk dependency scenarios in CI.
2. Findings are deterministic across repeated runs.
3. No core package dependency on plugin internals.

## Relationship to Other Plugins
1. Typegen plugin remains independent and should proceed first.
2. Backfill plugin can consume dependency findings when implemented.
