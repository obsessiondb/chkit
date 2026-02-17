# Release Process

All packages are published to npm under the `@chkit` scope with the `beta` dist-tag.

## Prerequisites

- On the `main` branch with a clean working tree
- Authenticated to npm (`npm login` — bun reads auth from `~/.npmrc`)
- `bun`, `git`, `npm` installed
- At least one **new** pending changeset in `.changeset/` (see [Adding a Changeset](#adding-a-changeset) below)

## Quick Reference

```bash
# Dry run (validates everything, does not publish)
bun run release:manual -- --dry-run

# Full release
bun run release:manual
```

## How It Works

The `release:manual` script (`scripts/manual-release.ts`) runs these steps:

1. **Validate changesets** - confirms `.changeset/*.md` files exist and all bumps are `patch` (only patch is allowed during beta)
2. **Check tools** - verifies bun, git, npm, changeset CLI are available
3. **Check branch** - must be on `main`
4. **Check working tree** - must be clean
5. **Check npm auth** - verifies `npm whoami` succeeds (run `npm login` first if needed)
6. **Quality gates** - runs lint, typecheck, test, build
7. **Ensure beta prerelease mode** - enters changeset pre mode if not already active
8. **Version packages** - runs `changeset version` to bump versions and update changelogs
9. **Resolve workspace deps** - replaces `workspace:*` with concrete versions in package.json files
10. **Confirm** - interactive prompt before publishing
11. **Publish** - runs `bun publish --tag beta` for each non-private package
12. **Manual follow-up** - commit and push the version/changelog changes on main

## After Publishing

The script leaves uncommitted changes (bumped versions, updated changelogs, consumed changesets). You must:

```bash
git add -A
git commit -m "chore: version packages"
git push origin main
```

## Adding a Changeset

You **must** create at least one changeset before running `release:manual`. Without a new changeset, `changeset version` has nothing to bump, and the script will attempt to re-publish an already-published version.

```bash
bun run changeset
```

Follow the interactive prompts. Only `patch` bumps are allowed during the beta phase.

Alternatively, create a file manually in `.changeset/` with this format:

```markdown
---
"@chkit/core": patch
"@chkit/clickhouse": patch
---

Description of the change.
```

## Why bun publish?

This monorepo uses `workspace:*` for internal dependencies. `bun publish` is used instead of `npm publish` because it handles scoped packages and `--tag` more reliably.

**Note:** `bun publish` is supposed to resolve `workspace:*` references automatically, but has a [known bug](https://github.com/oven-sh/bun/issues/24687) where this does not work. The release script works around this by resolving `workspace:*` to concrete versions in the package.json files before publishing. These resolved versions are included in the post-release commit.

## Authentication

`bun publish` reads npm auth from `~/.npmrc`. Run `npm login` to authenticate:

```bash
npm login
```

This writes a token to `~/.npmrc` that both `npm` and `bun` will use. The release script verifies auth with `npm whoami` before proceeding.

## Prerelease Mode

The repo is in changeset prerelease mode (`beta`). This is tracked in `.changeset/pre.json`. All published versions get a `-beta.N` suffix and are tagged as `beta` on npm, so `npm install @chkit/core` will not install beta versions unless explicitly requested with `@beta`.

To exit prerelease mode (when ready for stable):

```bash
bun run changeset -- pre exit
```
