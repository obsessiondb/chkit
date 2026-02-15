# CHX Manual npm Release Script Spec (Beta-Only, Dead Simple)

Status: proposed  
Date: 2026-02-13  
Owner: core maintainers

## Purpose
Ship CHX with the smallest possible local release workflow while pre-1.0:
- one command to create a changeset,
- one command to publish whatever pending changesets exist.

This is intentionally minimal and optimized for maintainers releasing from `main`.

## Scope
### In Scope
- A single no-argument local release command.
- Beta-only publishing flow (`npm dist-tag: beta`).
- Patch-only intent for release bumps.
- Basic safety checks (clean git, npm auth, quality gates).
- Human review of generated changeset files before publish.

### Out of Scope
- Stable `latest` releases.
- Multiple channels (`alpha`, `latest`) and channel arguments.
- CI publishing.
- GitHub Release automation.

## Constraints
1. Project remains pre-1.0; major version must stay `0`.
2. For now, release intent is patch-only.
3. Releases are run manually from a maintainer machine on `main`.
4. No history rewrites for release recovery.

## Operator Workflow (Two Commands)
1. Create changeset:

```bash
bun run changeset
```

2. In the interactive prompt, choose `patch` for every affected package.
3. Review the generated file(s) under `.changeset/*.md`.
4. Publish release:

```bash
bun run release:manual
```

## Script Interface
- Root script:
  - `"release:manual": "bun run ./scripts/manual-release.ts"`
- No required arguments.
- Optional:
  - `--dry-run`: run checks and version planning only; do not publish.

## Release Flow (`bun run release:manual`)
1. Validate required tools exist (`bun`, `git`, `npm`, `changeset`).
2. Validate git state:
   - current branch is `main`,
   - working tree is clean.
3. Validate npm auth:
   - `npm whoami` succeeds.
4. Run quality gates:
   - `bun run lint`
   - `bun run typecheck`
   - `bun run test`
   - `bun run build`
5. Ensure prerelease mode for beta:
   - if not already in prerelease mode, run `changeset pre enter beta`.
6. Version pending changesets:
   - run `bun run version-packages`.
7. Enforce version policy:
   - fail if any target version has major `>= 1`,
   - fail if a change is not patch-intent for this phase.
8. Prompt confirmation for non-dry-run:
   - `Proceed with npm publish to beta? [y/N]`
9. Publish:
   - run `changeset publish --tag beta`.
10. Print summary:
   - published package names and versions,
   - any follow-up action required.

## Failure Handling
1. Failure before publish:
   - nothing released; fix and rerun.
2. Failure during publish (partial publish):
   - do not rewrite git history,
   - retry publishing missing packages at the same version,
   - if recovery is messy, cut a follow-up patch release.
3. Failure after publish:
   - do not republish already-published versions.

## Safety Rules
- Stop on first failed command.
- Echo each external command before execution.
- Always require explicit confirmation before real publish.
- Write a temporary log to `.tmp/release-manual-<timestamp>.log`.

## Acceptance Criteria
- `bun run changeset` creates a reviewable changeset file.
- `bun run release:manual -- --dry-run` performs checks and version planning without publishing.
- `bun run release:manual` publishes pending changesets to npm tag `beta`.
- Script rejects any release that would move to major `>= 1`.
- Script rejects non-patch release intent for this phase.

## Implementation Checklist
- [ ] Add `scripts/manual-release.ts`.
- [ ] Add root script `release:manual` in `package.json`.
- [ ] Add preflight checks (git clean/main, npm auth, required CLIs).
- [ ] Add beta prerelease bootstrap (`changeset pre enter beta` when needed).
- [ ] Add patch-intent and `major === 0` guards.
- [ ] Add dry-run mode.
- [ ] Document operator runbook in `docs/03-delivery-playbook.md`.
