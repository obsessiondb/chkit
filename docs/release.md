# Release Process

All 10 published packages share one semver version (a changesets `fixed` group) and publish together. While in beta, versions carry a `-beta.N` suffix.

## Releasing

A release takes two steps. The version reaches git before npm, so any failure can simply be re-run.

1. **Run "Release: prepare"** (GitHub → Actions → Release: prepare → Run workflow; repo admins only). Pick a channel:
   - `beta` cuts the next beta from the unreleased changesets.
   - `stable` graduates the beta line to GA (e.g. `0.2.0-beta.N` becomes `0.2.0`). Outside pre mode it cuts a stable release from the unreleased changesets.

   It versions the packages, pushes a `release/v<version>` branch, opens a `release: v<version>` PR with the changelog as its body, and starts CI on that branch.
2. **Review and merge the release PR.** That is the release decision. Keep the squash title `release: v<version> (#N)`: "Release: publish" recognizes the release commit by it.

"Release: publish" then runs the quality gates and release guards, publishes every package to npm, moves dist-tags, and creates the `v<version>` tag and GitHub release.

| Version | npm dist-tags |
|---------|---------------|
| prerelease (`0.2.0-beta.9`) | `beta`, and `latest` is moved onto it (the docs use unqualified installs) |
| stable (`0.2.0`) | `latest` |

### When main moves before you merge

If new changesets land on `main` after prepare, re-run "Release: prepare" before merging: it refreshes the PR. Publish refuses a release commit that still has unreleased changesets, because their changes would ship without a changelog entry. If that happens after a merge, re-run prepare to cut the next version.

### Retrying a failed release

Re-run the failed "Release: publish" run. Every step skips what is already done: published packages, dist-tags, the GitHub release. The publish job only runs for repo admins; if someone else merged the release PR, an admin re-runs it.

A manual dispatch of "Release: publish" publishes whatever version `main` is at; `dry_run` rehearses it with `npm publish --dry-run`.

## Previews

Every push to `main` is published to [pkg.pr.new](https://pkg.pr.new), not npm:

```bash
bun add -d https://pkg.pr.new/chkit@<sha>   # a specific commit
bun add -d https://pkg.pr.new/chkit@main    # latest main
```

Sibling `@chkit/*` dependencies resolve to the same commit's previews.

## Adding a Changeset

Every user-facing change needs a changeset. Without one, prepare has nothing to release.

```bash
bun run changeset
```

Or create a file in `.changeset/`:

```markdown
---
"@chkit/core": patch
---

Description of the change.
```

Use `patch` while in beta. `major` changesets are rejected.

## How publishing works

- **npm auth:** OIDC Trusted Publishing from GitHub Actions; no npm token for the publish itself. Trusted Publishing does not support self-hosted runners, so the job runs on GitHub-hosted `ubuntu-24.04` (Blacksmith runners register as self-hosted).
- **`npm publish`, not `bun publish`:** bun cannot publish via OIDC. `npm publish` copies `workspace:*` into the tarball verbatim, so the script rewrites every internal dependency to the current workspace version before publishing and restores `package.json` afterwards (`scripts/workspace-deps.ts`). `check:packed-deps` packs with `npm pack` after the same rewrite and fails on any leftover `workspace:` or stale pin.
- **dist-tags:** moving `latest` onto a beta (`npm dist-tag add`) authenticates via OIDC too, which needs npm >= 11.21.0. The workflow pins `npm@^11.21.0`. No npm token is stored anywhere.
- **Quality gates:** `bun run verify` (typecheck, lint, test and build against the local test stack in `test/infra`), as in CI's `verify` job.

## One-time setup

- On each of the 10 packages on npmjs.com: add a Trusted Publisher → GitHub Actions → `obsessiondb/chkit`, workflow `release-publish.yml`, environment `release`, and enable **Allow npm dist-tag** (off by default). Without it a beta release publishes but fails to move `latest`; enable it and re-run the run.
- In the GitHub repo: create the `release` environment with deployment branches limited to `main`.
- Install the [pkg.pr.new GitHub App](https://github.com/apps/pkg-pr-new) on the repo.

## Without CI

From a clean `main` that matches `origin/main`:

```bash
bun run release:prepare [--stable]   # opens the release PR as you
bun run release:publish [--dry-run]  # after merging: publishes from local main, prompts for an npm OTP
```

## Prerelease Mode

The repo is in changesets prerelease mode (`beta`), tracked in `.changeset/pre.json`. In pre mode, released changeset files stay on disk and are listed in `pre.json`; a changeset counts as unreleased when its file is not listed there. A `stable` prepare exits pre mode; the next `beta` prepare enters it again.
