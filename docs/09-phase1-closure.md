# Phase 1 Closure Checklist

Source of truth: `docs/02-phased-roadmap.md` (Phase 1 section).

## Deliverables

| ID | Roadmap item | Status | Evidence |
|---|---|---|---|
| D1 | canonical schema snapshot format v1 | PASS | `packages/core/src/snapshot.ts`, `packages/core/src/model.ts` (`SnapshotV1`), `packages/codegen/src/index.ts` writes `snapshot.json`, `packages/codegen/src/index.test.ts` asserts `"version": 1`. |
| D2 | diff planner v1 (create/drop/additive focused) | PASS | `packages/core/src/planner.ts` (`planDiff`, operation ordering, risk summary), `packages/core/src/index.test.ts` planner suite (create/drop/additive/non-additive ordering). |
| D3 | SQL renderer v1 | PASS | `packages/core/src/sql.ts` (`toCreateSQL`, alter renderers), `packages/core/src/index.test.ts` SQL assertions. |
| D4 | CLI production-ready: `init`, `generate`, `migrate`, `status` | PASS | `packages/cli/src/bin/commands/init.ts`, `packages/cli/src/bin/commands/generate.ts`, `packages/cli/src/bin/commands/migrate.ts`, `packages/cli/src/bin/commands/status.ts`, JSON contract tests in `packages/cli/src/index.test.ts`. |

## Tasks

| ID | Roadmap task | Status | Evidence |
|---|---|---|---|
| T1 | Implement canonicalization rules in core | PASS | `packages/core/src/canonical.ts` (stable sort, normalization, dedup), tested in `packages/core/src/index.test.ts`. |
| T2 | Add diff planner with ordered operation output | PASS | `packages/core/src/planner.ts` (`operations.sort(...)`), deterministic-order test in `packages/core/src/index.test.ts`. |
| T3 | Add risk tags in plan output | PASS | `MigrationOperation.risk` in `packages/core/src/model.ts`; risk tagging in `packages/core/src/planner.ts`; surfaced via `generate --plan` in `packages/cli/src/bin/commands/generate.ts`. |
| T4 | Improve migration file format with headers and metadata | PASS | `packages/codegen/src/index.ts` (`-- chx-migration-format: v1`, generated-at, cli-version, counts, risk summary). |
| T5 | Improve migrate execution and journal semantics | PASS | `packages/cli/src/bin/commands/migrate.ts` (checksums, danger gate, sequential apply, per-file journal write), journal helpers in `packages/cli/src/bin/lib.ts`. |
| T6 | Add `--plan` and `--json` output modes | PASS | `generate`/`migrate`/`status` in command handlers + JSON envelope in `packages/cli/src/bin/lib.ts`; contract assertions in `packages/cli/src/index.test.ts`. |
| T7 | Add comprehensive unit tests for planner | PASS | Planner coverage in `packages/core/src/index.test.ts` across create/drop/additive/non-additive/view/MV/validation/determinism. |

## Exit Criteria

| ID | Exit criterion | Status | Evidence |
|---|---|---|---|
| E1 | Two demo projects can use full loop end-to-end | PASS | Live ClickHouse E2E: `doppler run --project chx --config ci -- bun test packages/cli/src/clickhouse-live.e2e.test.ts` passes both project flows (`runs init + generate + migrate + status...`, `runs additive second migration cycle...`). |
| E2 | Deterministic output validated by tests | PASS | Determinism tests in `packages/core/src/index.test.ts` (`plan ordering is deterministic...`), stable JSON key tests in `packages/cli/src/index.test.ts`, deterministic migration-id test in `packages/cli/src/index.test.ts`. |
| E3 | No critical defects in additive migration flow | PASS | Fixed false-positive drift defects; regression tests added in `packages/cli/src/drift.test.ts`; live check flow now passes in `packages/cli/src/clickhouse-live.e2e.test.ts`. |

## Phase 1 Gap Summary

- Implementation gaps fixed:
  - Optional env gating for live E2E credential checks.
  - Drift false positives for quoted string defaults.
  - Drift false positives from implicit engine settings.
  - Drift false positives for `MergeTree` vs `SharedMergeTree`.
  - Engine parser robustness for single-line `create_table_query`.
- Documentation-only gaps fixed:
  - Removed obsolete deferred validation TODO doc (`docs/06-validation-todo.md`).
  - Updated docs index prompt and command list (`docs/README.md`).
