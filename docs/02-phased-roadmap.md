# CHX Phased Roadmap

Status audit: 2026-02-10 (based on current repository state).
Legend: `[x]` complete, `[ ]` pending/unverified.

## Planning Assumptions
- [x] Small core team (1-3 engineers).
- [x] Weekly incremental releases.
- [x] Scope control: keep advanced ClickHouse operational workflows out of core until foundation is stable.

## Phase 0: Foundation Hardening (Current Scaffold -> Real Baseline)
Duration: 1-2 weeks

### Objectives
- [x] Stabilize repository structure and coding standards.
- [x] Establish testing, linting, release scaffolding.
- [x] Freeze initial architecture decisions.

### Deliverables
- [x] CI pipeline (typecheck, test, build).
- [x] test framework + baseline tests.
- [x] unified error model.
- [x] docs baseline complete.

### Tasks
- [ ] Add Vitest across packages. (Bun test is used instead.)
- [x] Add ESLint + Prettier or Biome with strict config.
- [x] Add Changesets for versioning.
- [x] Define release foundation spec (`docs/06-release-foundation-spec.md`).
- [ ] Add release automation skeleton.
- [x] Add dependency policy (`bun.lock` checks in CI).

## Phase 1: MVP Core Migration Loop
Duration: 2-4 weeks

### Objectives
- [x] Build dependable schema -> migration -> apply loop.
- [x] Support essential ClickHouse table/view/MV creation workflows.
- [x] Keep behavior deterministic and review-friendly.

### Deliverables
- [x] canonical schema snapshot format v1.
- [x] diff planner v1 (create/drop/additive changes focused).
- [x] SQL renderer v1.
- [x] CLI commands production-ready for:
  - `init`
  - `generate`
  - `migrate`
  - `status`

### Tasks
- [x] Implement canonicalization rules in core.
- [x] Add diff planner with ordered operation output.
- [x] Add risk tags in plan output.
- [x] Improve migration file format with headers and metadata.
- [x] Improve migrate execution and journal semantics.
- [x] Add dry-run planning and `--json` output modes.
- [x] Add comprehensive unit tests for planner.

## Phase 2: Safety, Drift, and Schema Evolution Depth
Duration: 3-5 weeks

### Objectives
- [x] Support richer schema evolution safely.
- [x] Detect DB drift and block unsafe assumptions.
- [x] Improve production-readiness.

### Deliverables
- [x] enhanced diff operations:
  - modify/drop column
  - settings modifications
  - TTL changes
  - index lifecycle ops
- [x] drift detection command (`chx drift` or `chx check`).
- [x] stronger safeguards for destructive operations.

### Tasks
- [x] Implement ClickHouse introspection mapping to canonical model.
- [x] Add drift report format.
- [x] Add safety policy config:
  - `allowDestructive`
- [x] Add forced explicit flags for dangerous ops.
- [x] Add operation-level validation and warnings.

## Phase 3: Deferred Optional Features (Pick-and-Choose)
Duration: scheduled after core phases based on priority and real-world demand.

### Objectives
- [x] Keep the core roadmap focused on must-have migration reliability.
- [x] Track advanced features as optional modules that can be adopted independently.

### Optional Feature Docs
- [ ] `optional-feature-rename-assistance-flow.md` (referenced but file not present in repo)
- [x] `optional-feature-clickhouse-compatibility-matrix.md`
- [x] `optional-feature-engine-specific-validation.md`
- [x] `optional-feature-dependency-intelligence-plugin.md`
- [x] `optional-feature-backfill-orchestration-plugin.md`

### Exit Criteria
- [ ] Core phases (0-2) are stable and production-usable for target non-distributed workflows.
- [ ] Optional features are pulled in only when justified by concrete usage scenarios.

## Phase 4: Plugin System and Optional Modules
Duration: 3-6 weeks

### Objectives
- [x] Keep core clean while enabling advanced workflows.
- [x] Introduce pluggable command and planning hooks.

### Deliverables
- [x] plugin API v1.
- [x] plugin loading and isolation in CLI.
- [x] first-party optional plugins:
  - [x] type generation plugin
  - [x] backfill orchestration (preview)

### Tasks
- [x] implement hook lifecycle.
- [x] add plugin manifest and config registration.
- [x] add plugin-specific command namespace.
- [x] define plugin stability and version compatibility rules.

### Exit Criteria
- [x] At least one external plugin demo works.
- [x] core package has no direct dependency on plugin internals.

## Phase 5: DX and Ecosystem
Duration: ongoing
Execution note: deferred until end-game verification and real-project validation are complete.

### Objectives
- [ ] Improve adoption and day-2 ergonomics.
- [ ] Ensure docs, examples, and onboarding are strong.

### Deliverables
- [ ] starter templates and examples.
- [ ] richer docs and troubleshooting guides.
- [ ] polished CLI output and ergonomics.
- [ ] potential Studio/pro dashboard exploration.

### Tasks
- [ ] Add examples:
  - [ ] simple single-node project
  - [ ] migration-heavy project
- [ ] Add troubleshooting matrix.
- [ ] Add CI recipes (GitHub Actions examples).
- [ ] Add migration review checklist docs.

### Exit Criteria
- [ ] New users can onboard in <30 minutes.
- [ ] recurring support issues drop release-over-release.

## Cross-Phase Tracks

### A. Quality Track
- [ ] increase integration coverage around risky migration and drift workflows.

### B. Release Track
- [ ] prerelease channels (`alpha`, `beta`).
- [ ] release notes automation.
- [x] migration format change warnings.

## Detailed Milestone Plan (Suggested)

### Milestone M1 (end of Phase 0)
- [x] CI + test harness + contribution docs.
- [x] stable scaffolding from current repo.

### Milestone M2 (early Phase 1)
- [x] canonical snapshot + basic diff.
- [x] generate/status mature enough for internal use.

### Milestone M3 (end of Phase 1)
- [x] migrate execution stable.
- [ ] first internal project onboarded.

### Milestone M4 (mid Phase 2)
- [x] drift detection with actionable output.
- [x] safer destructive flow.

### Milestone M5 (optional feature selection gate)
- [ ] decide which optional features to implement next based on production signals.
- [ ] schedule selected optional features as focused, standalone deliveries.

### Milestone M6 (Phase 4)
- [x] plugin API release.
- [x] type generation plugin preview.

### Milestone M7 (v1.0 target)
- [ ] SemVer stability promise.
- [ ] production hardening complete.
- [ ] multi-project adoption confirmed.

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
