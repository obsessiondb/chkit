# CHX Release Foundation Spec

Status: proposed  
Date: 2026-02-10  
Owner: core maintainers

## Purpose
Define the minimum release system required to ship CHX safely and repeatedly:
- automated release PR flow,
- prerelease channels (`alpha`, `beta`),
- release notes automation,
- consistent publish and rollback procedure.

## Scope
### In Scope
- GitHub Actions release automation using Changesets.
- npm publish for packages under `packages/*`.
- Auto-generated changelog/release notes from Changesets.
- Stable and prerelease distribution channels.

### Out of Scope
- Binary installers.
- Homebrew/npm dist-tag migration tooling beyond base scripts.
- Full release dashboard UI.

## Current Baseline
- Changesets is configured (`.changeset/config.json`).
- Root scripts exist:
  - `bun run changeset`
  - `bun run version-packages`
  - `bun run release`
- CI exists (`.github/workflows/ci.yml`) but no release workflow yet.

## Requirements
1. Every user-facing change must carry a changeset file unless explicitly skipped.
2. Main branch merges should create/update a single release PR automatically.
3. Publishing should run only from the release PR merge commit.
4. Failed publish must be recoverable without rewriting git history.
5. Prerelease flow must support `alpha` and `beta` with dist-tags.

## Release Model
### Stable (`latest`)
- Trigger: merge release PR into `main`.
- Action: `changeset version` then `changeset publish`.
- Output:
  - version bumps,
  - changelog updates,
  - GitHub Release notes,
  - npm publish with `latest` tag.

### Prerelease (`alpha`, `beta`)
- Trigger: manual workflow dispatch.
- Action:
  - enter prerelease mode (`changeset pre enter <tag>`),
  - publish prerelease versions (`x.y.z-<tag>.<n>`),
  - exit prerelease mode when done (`changeset pre exit`).
- Output:
  - npm dist-tag `alpha` or `beta`,
  - GitHub prerelease entry.

## GitHub Actions Design
### 1) `release-pr.yml`
- Trigger: push to `main`.
- Job:
  - checkout + install (`bun install --frozen-lockfile`),
  - run `changesets/action` to open or update release PR,
  - include generated changelog/version commits.

### 2) `publish.yml`
- Trigger: push to `main` where commit is release PR merge.
- Guards:
  - run `bun run typecheck`, `bun run test`, `bun run build` before publish.
- Publish:
  - `bun run release`.
- Post-publish:
  - create/update GitHub Release notes,
  - attach package/version summary artifact.

### 3) `prerelease.yml`
- Trigger: `workflow_dispatch` with input `channel` = `alpha|beta`.
- Job:
  - validate clean pre state,
  - run pre enter/publish,
  - push version/changelog commits,
  - create GitHub prerelease.

## Secrets and Permissions
- Required secrets:
  - `NPM_TOKEN` (publish),
  - `GITHUB_TOKEN` (default action token).
- Workflow permissions:
  - `contents: write`,
  - `pull-requests: write`,
  - `id-token: write` (only if moving to trusted publishing).

## Branch/Tag Strategy
- Default branch: `main`.
- Release tags: `v<version>` (e.g. `v0.4.0`).
- Do not publish from feature branches.

## Failure and Rollback Policy
1. If versioning fails before publish: rerun workflow after fixing CI.
2. If partial publish occurs:
   - do not delete git tags,
   - publish missing packages with same versions,
   - if impossible, issue patch release with corrective note.
3. If bad release ships:
   - publish forward fix (preferred),
   - deprecate broken npm version if needed.

## Definition of Done
- `release-pr.yml` creates release PR automatically after merge to `main`.
- Merging release PR publishes to npm `latest`.
- Manual prerelease workflow publishes `alpha` and `beta` successfully.
- GitHub release notes are generated without manual copy/paste.
- Runbook exists in `docs/03-delivery-playbook.md` referencing these workflows.

## Implementation Checklist
- [ ] Add `.github/workflows/release-pr.yml`.
- [ ] Add `.github/workflows/publish.yml`.
- [ ] Add `.github/workflows/prerelease.yml`.
- [ ] Enforce changeset presence on PRs (or explicit skip label).
- [ ] Add release notes template for GitHub releases.
- [ ] Document runbook updates in delivery playbook.
