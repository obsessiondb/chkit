# CHX Phased Roadmap

## Planning Assumptions
1. Small core team (1-3 engineers).
2. Weekly incremental releases.
3. Scope control: keep advanced ClickHouse operational workflows out of core until foundation is stable.

## Phase 0: Foundation Hardening (Current Scaffold -> Real Baseline)
Duration: 1-2 weeks

### Objectives
1. Stabilize repository structure and coding standards.
2. Establish testing, linting, release scaffolding.
3. Freeze initial architecture decisions.

### Deliverables
1. CI pipeline (typecheck, test, build).
2. test framework + baseline tests.
3. unified error model.
4. docs baseline complete.

### Tasks
1. Add Vitest across packages.
2. Add ESLint + Prettier or Biome with strict config.
3. Add Changesets for versioning.
4. Add release automation skeleton.
5. Add dependency policy (`bun.lock` checks in CI).

### Exit Criteria
1. CI green on PR.
2. baseline tests in each package.
3. contributor guide and architecture docs merged.

## Phase 1: MVP Core Migration Loop
Duration: 2-4 weeks

### Objectives
1. Build dependable schema -> migration -> apply loop.
2. Support essential ClickHouse table/view/MV creation workflows.
3. Keep behavior deterministic and review-friendly.

### Deliverables
1. canonical schema snapshot format v1.
2. diff planner v1 (create/drop/additive changes focused).
3. SQL renderer v1.
4. CLI commands production-ready for:
   - `init`
   - `generate`
   - `migrate`
   - `status`

### Tasks
1. Implement canonicalization rules in core.
2. Add diff planner with ordered operation output.
3. Add risk tags in plan output.
4. Improve migration file format with headers and metadata.
5. Improve migrate execution and journal semantics.
6. Add `--plan` and `--json` output modes.
7. Add comprehensive unit tests for planner.

### Exit Criteria
1. Two demo projects can use full loop end-to-end.
2. deterministic output validated by tests.
3. no critical defects in additive migration flow.

## Phase 2: Safety, Drift, and Schema Evolution Depth
Duration: 3-5 weeks

### Objectives
1. Support richer schema evolution safely.
2. Detect DB drift and block unsafe assumptions.
3. Improve production-readiness.

### Deliverables
1. enhanced diff operations:
   - modify/drop column
   - settings modifications
   - TTL changes
   - index lifecycle ops
2. drift detection command (`chx drift` or `chx check`).
3. stronger safeguards for destructive operations.

### Tasks
1. Implement ClickHouse introspection mapping to canonical model.
2. Add drift report format.
3. Add safety policy config:
   - `allowDestructive`
4. Add forced explicit flags for dangerous ops.
5. Add operation-level validation and warnings.

### Exit Criteria
1. Drift report trusted in at least one production-like environment.
2. destructive operations always gated.
3. no silent destructive SQL in default mode.

## Phase 3: Advanced ClickHouse Semantics
Duration: 4-8 weeks

### Objectives
1. Handle distributed/cluster-specific behaviors better.
2. Add optional rename and compatibility helpers.
3. Reduce pain points from existing custom infra migrations.

### Deliverables
1. distributed table strategy support:
   - local + distributed pair modeling
   - cluster-aware SQL rendering options
2. rename assistance flow (interactive + guarded).
3. compatibility matrix by ClickHouse version.

### Tasks
1. Introduce distributed mode DSL extensions.
2. Implement rename detection as optional planner pass.
3. Validate engine-specific constraints before render.
4. Add integration tests for cluster/distributed scenarios.

### Exit Criteria
1. Existing `clickhouse-infra` core schema patterns can be represented.
2. distributed migrations validated in staging environments.

## Phase 4: Plugin System and Optional Modules
Duration: 3-6 weeks

### Objectives
1. Keep core clean while enabling advanced workflows.
2. Introduce pluggable command and planning hooks.

### Deliverables
1. plugin API v1.
2. plugin loading and isolation in CLI.
3. first-party optional plugins:
   - dependency graph
   - backfill orchestration (preview)
   - type generation plugin

### Tasks
1. implement hook lifecycle.
2. add plugin manifest and config registration.
3. add plugin-specific command namespace.
4. define plugin stability and version compatibility rules.

### Exit Criteria
1. At least one external plugin demo works.
2. core package has no direct dependency on plugin internals.

## Phase 5: DX and Ecosystem
Duration: ongoing

### Objectives
1. Improve adoption and day-2 ergonomics.
2. Ensure docs, examples, and onboarding are strong.

### Deliverables
1. starter templates and examples.
2. richer docs and troubleshooting guides.
3. polished CLI output and ergonomics.
4. potential Studio/pro dashboard exploration.

### Tasks
1. Add examples:
   - simple single-node project
   - distributed cluster project
   - migration-heavy project
2. Add troubleshooting matrix.
3. Add CI recipes (GitHub Actions examples).
4. Add migration review checklist docs.

### Exit Criteria
1. New users can onboard in <30 minutes.
2. recurring support issues drop release-over-release.

## Cross-Phase Tracks

### A. Quality Track
1. increase unit and integration coverage.
2. flaky test budget policy.
3. deterministic fixture snapshots.

### B. Security Track
1. secret redaction.
2. dependency audit checks.
3. secure defaults for CLI logging.

### C. Release Track
1. prerelease channels (`alpha`, `beta`).
2. release notes automation.
3. migration format change warnings.

## Detailed Milestone Plan (Suggested)

### Milestone M1 (end of Phase 0)
1. CI + test harness + contribution docs.
2. stable scaffolding from current repo.

### Milestone M2 (early Phase 1)
1. canonical snapshot + basic diff.
2. generate/status mature enough for internal use.

### Milestone M3 (end of Phase 1)
1. migrate execution stable.
2. first internal project onboarded.

### Milestone M4 (mid Phase 2)
1. drift detection with actionable output.
2. safer destructive flow.

### Milestone M5 (end of Phase 3)
1. distributed-aware schema support.
2. rename helper (manual confirmation required).

### Milestone M6 (Phase 4)
1. plugin API release.
2. first-party plugins preview.

### Milestone M7 (v1.0 target)
1. SemVer stability promise.
2. production hardening complete.
3. multi-project adoption confirmed.

## Resourcing Guidance
1. Minimum for MVP:
   - 1 engineer full-time for 4-6 weeks.
2. Faster path:
   - 2 engineers with split:
     - engineer A: core + codegen
     - engineer B: clickhouse adapter + CLI + tests

## Known Blockers to Watch
1. ClickHouse version differences in introspection output.
2. ambiguous schema diffs for complex defaults and expressions.
3. balancing safe defaults with operational flexibility.

## Decision Gates
At end of each phase, decide:
1. proceed to next phase unchanged,
2. stabilize and extend current phase,
3. de-scope features to protect reliability.
