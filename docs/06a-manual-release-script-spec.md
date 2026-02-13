# CHX Manual npm Release Script Spec (Pre-CI)

Status: proposed  
Date: 2026-02-12  
Owner: core maintainers

## Purpose
Define a local, human-invoked release script that publishes CHX packages to npm safely before full CI release automation is in place.

This script is the Phase 0 release path and must map directly to the future CI flow.

## Scope
### In Scope
- A single local command to run stable or prerelease publishing.
- Guardrails before publish (clean git state, branch, tests/build, npm auth).
- Enforcement of pre-1.0 version policy (`0.x.y`).
- Support for prerelease channels (`alpha`, `beta`).
- Output summary of published packages/versions.

### Out of Scope
- GitHub Release creation.
- Release PR automation.
- Trusted publishing setup.
- Publishing from CI (covered by later workflows).

## Constraints
1. Project is pre-1.0: all published versions must be `0.x.y` (and prerelease variants like `0.x.y-alpha.n`).
2. Releases are performed from a local machine by a maintainer.
3. Release history must stay forward-only (no tag/history rewrites).

## Proposed Interface
Add a root script:

```bash
bun run release:manual -- --channel latest
```

Optional channels:

```bash
bun run release:manual -- --channel alpha
bun run release:manual -- --channel beta
```

Optional flags:
- `--skip-checks`: bypass test/typecheck/build gates (default: false; discouraged).
- `--dry-run`: run all validations and version planning but do not publish.

## Script Location
- `scripts/manual-release.ts`
- Root `package.json` script entry:
  - `"release:manual": "bun run ./scripts/manual-release.ts"`

## Release Flow
1. Parse args and validate `channel in {latest, alpha, beta}`.
2. Validate git state:
   - on `main` branch,
   - working tree clean,
   - local branch up to date with `origin/main`.
3. Validate environment:
   - `npm whoami` succeeds,
   - `NPM_TOKEN` is present (or explicit local auth exists),
   - required CLIs available (`bun`, `git`, `npm`).
4. Run quality gates (unless `--skip-checks`):
   - `bun run lint`
   - `bun run typecheck`
   - `bun run test`
   - `bun run build`
5. Enforce version policy before publish:
   - run `bun run version-packages`,
   - inspect changed `package.json` versions for publishable packages,
   - fail if any next version has major `>= 1`,
   - for prerelease channels, fail if resulting version format does not remain `0.x.y-<channel>.n`.
6. Channel-specific release execution:
   - `latest`:
     - ensure prerelease mode is not active,
     - run `bun run release`.
   - `alpha|beta`:
     - run `changeset pre enter <channel>`,
     - run `bun run version-packages`,
     - run `changeset publish --tag <channel>`,
     - run `changeset pre exit`.
7. Create git commit and tag(s) for release version changes:
   - commit message: `chore(release): publish <channel>`.
   - tags: `v<version>` only for stable (`latest`) release.
8. Push commit and tags.
9. Print release summary:
   - channel,
   - package names + versions,
   - tags created,
   - follow-up actions if partial publish occurred.

## Failure Handling
1. Failure before `changeset publish`:
   - no package was published; fix issue and rerun.
2. Failure during publish (partial publish):
   - do not delete tags or rewrite history,
   - detect missing packages and retry publishing only missing ones at same version,
   - if recovery fails, publish a follow-up patch.
3. Failure after publish, before push:
   - do not republish,
   - push commit/tags to reconcile git with npm state.

## Idempotency and Safety Rules
- Script must stop on first failed command.
- Script must print each external command before running it.
- Script must require explicit confirmation for non-dry-run publishing:
  - prompt: `Proceed with npm publish to <channel>? [y/N]`
- Script must store a temporary release log under `.tmp/release-manual-<timestamp>.log`.

## CI Migration Plan
Design the script so CI can reuse it with minimal branching:
1. Keep release orchestration in `scripts/manual-release.ts`.
2. Add `--ci` mode later:
   - disables prompts,
   - assumes detached checkout,
   - uses env-only auth.
3. Future workflows call this script instead of re-implementing release logic:
   - `.github/workflows/publish.yml` invokes `bun run release:manual -- --channel latest --ci`
   - `.github/workflows/prerelease.yml` invokes `bun run release:manual -- --channel alpha|beta --ci`

## Acceptance Criteria
- Running `bun run release:manual -- --channel latest --dry-run` performs all validations and exits without publishing.
- Running `bun run release:manual -- --channel latest` publishes successfully when all checks pass.
- Script fails if any target version resolves to `>=1.0.0`.
- Script supports `alpha` and `beta` channels with correct npm dist-tags.
- Output summary clearly shows what was published.

## Implementation Checklist
- [ ] Add `scripts/manual-release.ts`.
- [ ] Add root script `release:manual` in `package.json`.
- [ ] Add helper for semver policy check (`major === 0`).
- [ ] Add dry-run mode.
- [ ] Add non-interactive `--ci` mode scaffold (no workflow wiring yet).
- [ ] Document operator runbook in `docs/03-delivery-playbook.md`.
