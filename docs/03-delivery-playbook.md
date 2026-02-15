# CHX Delivery Playbook

## Purpose
This playbook defines how to execute CHX implementation work consistently and safely.

## Branching and Versioning
1. Use short-lived feature branches.
2. Merge behind CI only.
3. Use Changesets for package versions.
4. Publish prereleases early (`alpha`, then `beta`).

## Definition of Done (Per Story)
1. Requirements implemented.
2. Unit tests added/updated.
3. Integration tests added where adapter behavior changes.
4. Docs updated.
5. No TODO placeholders without follow-up issue.
6. Typecheck/lint/build all green.

## PR Checklist
1. Problem statement included.
2. Approach and trade-offs documented.
3. Backward compatibility impact noted.
4. Migration/format impact noted.
5. Testing evidence attached.

## Testing Pyramid

### Unit Tests
- `@chkit/core`:
  - normalization
  - diff planner
  - operation ordering
  - SQL rendering
- `@chkit/codegen`:
  - file naming
  - snapshots/journal semantics

### Integration Tests
- `@chkit/clickhouse` with real ClickHouse container:
  - create/apply/select checks
  - introspection consistency
  - failure/retry behavior

### End-to-End Tests
- CLI workflow:
  - init -> generate -> status -> migrate (plan)
  - migrate --execute on disposable DB
  - drift detection flow (phase 2)

## Test Environment Strategy
1. Unit tests run in all PRs.
2. Adapter integration tests run in PR and nightly.
3. E2E smoke runs in PR for critical commands.
4. Weekly longer scenario tests for regression detection.

## CI Pipeline (Target)
1. `bun install --frozen-lockfile`
2. `bun run typecheck`
3. `bun run lint`
4. `bun run test`
5. integration test job (ClickHouse service)
6. build artifacts

## Release Pipeline (Target)
1. On merge to main:
   - generate version bumps with Changesets
   - run full CI
2. Publish to npm under channel:
   - alpha/beta/stable
3. Generate release notes:
   - changed commands
   - breaking changes
   - migration format changes

## Error and Exit Code Policy
1. `0`: success.
2. `1`: user error (bad config, invalid schema).
3. `2`: runtime/system error (connection, I/O).
4. `3`: unsafe operation blocked by policy.

## Observability and Debugging
1. `--verbose` for detailed trace logs.
2. `--json` for machine parsing.
3. include operation IDs in logs for cross-referencing plans and applied actions.

## Backward Compatibility Rules
1. No breaking CLI flag changes without deprecation period.
2. Migration/snapshot format version must be explicit.
3. Config key changes require deprecation aliases and warnings.

## Migration Format Governance
1. Include version field in snapshot metadata.
2. Keep old readers for at least one major release window.
3. Provide `chx upgrade-meta` if format migration is required.

## Security and Secret Handling
1. never print raw passwords/tokens.
2. redact sensitive fields in error dumps.
3. provide secure env var docs for CI usage.

## Performance Targets
1. `generate` under 2s for small schemas (<50 objects).
2. linear-ish growth for larger schemas.
3. avoid N^2 diff operations where possible.

## Team Operating Rhythm
1. Weekly planning with strict phase scope.
2. Mid-week integration checkpoint.
3. Weekly release candidate cut.
4. Retrospective on incidents or migration regressions.

## Issue Taxonomy
1. `type:core`
2. `type:adapter`
3. `type:cli`
4. `type:codegen`
5. `type:plugin`
6. `type:docs`
7. `priority:p0-p3`
8. `risk:breaking`

## Risk Mitigation Playbook

### Destructive SQL Risk
1. enforce explicit `--allow-destructive`.
2. default to plan mode when danger operations exist.
3. display before/after summary per operation.

### Drift Risk
1. block migrations if severe drift is detected (configurable).
2. provide suggested reconciliation commands.

### Adapter Runtime Risk
1. isolate failing statements.
2. persist partial progress with clear resume state.
3. improve retry strategy for transient failures only.

## Documentation Deliverables per Phase
1. command docs.
2. config reference.
3. examples.
4. troubleshooting section.
5. upgrade notes.

## Templates

### Feature Spec Template
1. Problem.
2. Goals/non-goals.
3. API/CLI changes.
4. Internal design.
5. Risks.
6. Test plan.
7. Rollout plan.

### Incident Report Template
1. Summary.
2. Impact.
3. Root cause.
4. Detection gap.
5. Fix.
6. Preventative actions.
