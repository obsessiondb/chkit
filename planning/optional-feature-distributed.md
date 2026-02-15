# CHX Optional Feature: Distributed and Cluster Support

## Status
Deferred. Not part of the current core roadmap and not required for the first use case.

## Why Deferred
1. The initial target workflow is non-distributed.
2. Distributed and cluster behavior adds planner, validation, rendering, and test complexity.
3. Deferring keeps core migration reliability and safety work focused.

## Scope (If Enabled Later)

### Objectives
1. Handle distributed/cluster-specific behaviors safely.
2. Support local + distributed table modeling with explicit semantics.
3. Reduce migration pain for existing cluster-oriented infrastructure.

### Deliverables
1. Distributed table strategy support:
   - local + distributed pair modeling
   - cluster-aware SQL rendering options
2. Rename assistance flow (interactive + guarded).
3. Compatibility matrix by ClickHouse version.

### Tasks
1. Introduce distributed mode DSL extensions.
2. Implement rename detection as optional planner pass.
3. Validate engine-specific constraints before render.
4. Add integration tests for cluster/distributed scenarios.

### Exit Criteria
1. Existing `clickhouse-infra` core schema patterns can be represented.
2. Distributed migrations validated in staging environments.

## Proposed DSL/Model Concepts
1. Optional cluster target per schema object or per render context.
2. Distributed table metadata that explicitly references local table target and sharding key.
3. Validation rules for:
   - distributed engine + metadata consistency
   - local/distributed pairing invariants
   - unsafe or ambiguous rename paths

## Planner and SQL Considerations
1. Optional rename detection pass with explicit confirmation requirement.
2. Deterministic ordering for local/distributed dependency operations.
3. Cluster-aware DDL rendering mode (for create/alter/drop paths).
4. Guardrails to prevent silent destructive behavior in distributed flows.

## Compatibility and Testing
1. Maintain ClickHouse-version compatibility notes for supported semantics.
2. Add integration tests that cover:
   - local/distributed pair creation
   - evolve local table with corresponding distributed behavior
   - guarded rename flow
   - cluster-aware SQL output
3. Validate against staging-like multi-node environments before rollout.

## Adoption Plan (Future)
1. Ship behind an explicit feature flag or opt-in config.
2. Start with plan-only and validation mode before execute mode defaults.
3. Document operational runbooks and rollback guidance before broad usage.
