# Optional Feature: Backfill Orchestration Plugin

## Status

- First-party optional plugin target.
- Treated as operationally sensitive and intentionally not part of core.
- Designed for phased rollout: preview first, stricter defaults after production validation.

## Problem

Schema migrations that affect materialized views, destination tables, or historical data correctness often require coordinated backfills. Manual backfill execution is error-prone, difficult to review, and risky at scale.

## Goals

1. Provide deterministic, reviewable backfill plans for ClickHouse workflows.
2. Add safety gates for high-risk execution paths (cluster load, duplicate ingestion, wrong time windows).
3. Reuse CHX plugin hooks and command namespace without coupling orchestration logic into core.
4. Support CI validation and operator-run execution with resumable state.

## Non-Goals (v1 Preview)

1. No automatic cluster-wide adaptive load balancing.
2. No auto-generated lineage graph UI.
3. No opaque "do everything" one-command production execution.
4. No dependency on custom infrastructure beyond ClickHouse and local CHX metadata.

## Why Plugin (Not Core)

1. Backfill policy is environment-specific and high-variance across teams.
2. Execution strategy (partition windows, throttling, guardrails) is operational, not schema-core behavior.
3. Failure blast radius is larger than core migration planning and needs independent lifecycle/versioning.

## Core vs Plugin Responsibility

### Keep in Core

1. Deterministic schema planning and migration execution.
2. Baseline destructive operation gating.
3. Plugin lifecycle runtime and command dispatch.

### Put in Plugin

1. Backfill plan construction and state machine.
2. Backfill policy validation and execution guards.
3. Progress tracking, resume semantics, and backfill-specific findings.

## Functional Scope (v1 Preview)

1. Build backfill plans from explicit targets (table or materialized view destination).
2. Partition or time-window chunking with deterministic ordering.
3. Dry-run plan output with estimated chunk count and SQL templates.
4. Execution with checkpointed progress and resume support.
5. Safety modes:
   - preview-only (plan)
   - execute-with-confirmation
   - execute-noninteractive (requires explicit force flags and policy allowances)
6. Optional integration with `chx check` to detect required-but-pending backfills.

## Operator UX and Command Model (Draft)

1. `chx backfill plan --target <db.table> --from <ts> --to <ts>`
   - Builds deterministic chunk plan only.
2. `chx backfill run --plan-id <id>`
   - Executes previously planned backfill with checkpoints.
3. `chx backfill resume --plan-id <id>`
   - Continues from last successful checkpoint.
4. `chx backfill status --plan-id <id>`
   - Reports chunk progress, failures, and runtime metrics.
5. `chx backfill cancel --plan-id <id>`
   - Marks in-progress plan as cancelled (no further chunks run).
6. `chx backfill doctor --plan-id <id>`
   - Provides actionable remediation for failed chunks.

## Hook Usage Plan

1. `onConfigLoaded`
   - Validate backfill plugin configuration and execution policy.
2. `onPlanCreated`
   - Detect migration operations likely to require backfill and emit metadata hints.
3. `onBeforeApply`
   - Enforce policy gates if migration is tagged as requiring post-migration backfill.
4. `onCheck`
   - Return plugin findings for pending/failed required backfills.
5. `onCheckReport`
   - Print human-readable summary lines for CI/operator output.

## Configuration Model (Draft)

```ts
plugins: [
  {
    resolve: "./plugins/backfill.ts",
    options: {
      stateDir: "./chx/meta/backfill",
      defaults: {
        chunkHours: 6,
        maxParallelChunks: 1,
        maxRetriesPerChunk: 3,
        requireIdempotencyToken: true,
      },
      policy: {
        requireDryRunBeforeRun: true,
        requireExplicitWindow: true,
        blockOverlappingRuns: true,
        failCheckOnRequiredPendingBackfill: true,
      },
      limits: {
        maxWindowHours: 24 * 30,
        minChunkMinutes: 15,
      },
    },
  },
];
```

## State and Artifact Model (Draft)

State is persisted in plugin-scoped metadata to support resume and audit.

1. `meta/backfill/plans/<plan-id>.json`
   - immutable plan definition, target, window, chunk strategy, generated SQL templates.
2. `meta/backfill/runs/<plan-id>.json`
   - mutable execution state and chunk checkpoints.
3. `meta/backfill/events/<plan-id>.ndjson`
   - append-only operational event log.

Example plan state:

```ts
type BackfillPlanStatus =
  | "planned"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

interface BackfillChunk {
  id: string;
  from: string;
  to: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  attempts: number;
  lastError?: string;
}

interface BackfillPlanState {
  planId: string;
  target: string;
  createdAt: string;
  status: BackfillPlanStatus;
  chunks: BackfillChunk[];
  options: {
    chunkHours: number;
    maxParallelChunks: number;
  };
}
```

## Safety Model (Required)

1. Backfill run requires an existing successful `plan` output unless policy disables this explicitly.
2. Time window must be explicit (`--from`, `--to`) in non-interactive mode.
3. Overlapping active runs for same target are blocked by default.
4. Chunk execution is checkpointed after each success.
5. Failures do not silently continue past retry budget.
6. `--force` flags are split by risk class:
   - `--force-overlap`
   - `--force-large-window`
   - `--force-noninteractive`
7. Plugin emits explicit warning when configured with relaxed policy.

## Idempotency and Correctness Rules

1. Every chunk SQL must be deterministic for the same plan input.
2. Plan includes stable `idempotencyToken` per chunk.
3. Resume never replays chunks marked `done` unless operator passes `--replay-done`.
4. Chunk ordering is stable by window start time then chunk id.
5. Any mutable runtime inputs are persisted in plan state before run starts.

## Finding Codes (Draft)

1. `backfill_required_pending`
2. `backfill_plan_missing`
3. `backfill_plan_stale`
4. `backfill_overlap_blocked`
5. `backfill_window_exceeds_limit`
6. `backfill_chunk_failed_retry_exhausted`
7. `backfill_policy_relaxed`

## JSON Output Contract (Plugin Section Draft)

```json
{
  "plugins": {
    "backfill": {
      "evaluated": true,
      "ok": false,
      "findingCodes": ["backfill_required_pending"],
      "requiredCount": 1,
      "activeRuns": 0,
      "failedRuns": 0
    }
  }
}
```

## Algorithm Outline

1. Parse target and explicit time/partition window.
2. Normalize to canonical chunk boundaries.
3. Build immutable plan file and deterministic chunk IDs.
4. Validate policy constraints and active-run conflicts.
5. Execute chunk loop with retry budget and checkpoints.
6. Emit structured events after each chunk transition.
7. On completion, mark plan status and write summary.

## Failure and Recovery Behavior

1. Plugin-scoped errors must include plan id and chunk id when available.
2. Retry exhaustion marks chunk `failed` and plan `failed`.
3. `resume` revalidates config compatibility before execution continues.
4. If compatibility check fails, resume is blocked until operator acknowledges with explicit override.

## Testing Strategy

1. Unit tests:
   - chunking determinism
   - overlap detection
   - retry and checkpoint transitions
   - idempotency token stability
2. Integration tests:
   - `plan -> run -> status` happy path
   - fail then `resume`
   - policy gating in non-interactive mode
3. Contract tests:
   - stable finding codes
   - stable JSON fields for check integration

## Rollout Plan

1. Milestone A: plugin skeleton + `plan` command + state model.
2. Milestone B: `run/resume/status` with checkpointing and retries.
3. Milestone C: `onCheck` integration and CI gating for required backfills.
4. Milestone D: operator hardening in one production-like environment.

## Exit Criteria

1. Deterministic plan output for identical inputs across repeated runs.
2. Resume succeeds without duplicate execution in at least one failure scenario test.
3. Required-backfill findings integrate with `chx check` and are CI-consumable.
4. No core package dependency on plugin internals.

## Relationship to Other Plugins

1. Dependency-intelligence plugin can emit hints that a backfill is required.
2. Backfill plugin remains execution-focused and does not absorb full dependency graph responsibilities.
3. Typegen plugin remains independent from backfill lifecycle.
