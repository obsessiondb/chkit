# CHX Planning Docs Index

Use this order when bootstrapping a new planning/execution context:

1. `00-product-scope.md`
2. `01-architecture.md`
3. `02-phased-roadmap.md`
4. `03-delivery-playbook.md`
5. `04-migration-from-zeus.md`
6. `05-implementation-backlog.md`
7. `07-json-output-contract.md`
8. `08-internal-structure.md`
9. `09-phase1-closure.md` (closure checklist/evidence snapshot)

## Quick Prompt for New Context
If you start a fresh context window, paste this:

> Read all planning files in `/Users/marc/Workspace/chx/docs` in numeric order (`00`, `01`, `02`, `03`, `04`, `05`, `07`, `08`), then propose a concrete 2-week execution plan for Phase 0 + Phase 1 with PR-sized tasks, risk controls, and acceptance criteria.

## Current Repo Baseline
- Monorepo scaffold exists with packages:
  - `@chx/core`
  - `@chx/clickhouse`
  - `@chx/codegen`
  - `@chx/cli`
- Commands currently present:
  - `chx init`
  - `chx generate`
  - `chx migrate`
  - `chx status`
  - `chx drift`
  - `chx check`
  - `chx version`
