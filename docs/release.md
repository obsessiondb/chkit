# Release Process

All packages are published to npm under the `@chkit` scope with the `beta` dist-tag.

## Prerequisites

- On the `main` branch with a clean working tree
- Authenticated to npm (`npm whoami`)
- `bun`, `git`, `npm` installed
- At least one pending changeset in `.changeset/`

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
5. **Check npm auth** - runs `npm whoami`
6. **Quality gates** - runs lint, typecheck, test, build
7. **Ensure beta prerelease mode** - enters changeset pre mode if not already active
8. **Version packages** - runs `changeset version` to bump versions and update changelogs
9. **Resolve workspace references** - replaces `workspace:*` in all package.json files with the actual version numbers (changeset publish uses npm under the hood, which does not resolve workspace protocol)
10. **Confirm** - interactive prompt before publishing
11. **Publish** - runs `changeset publish --tag beta`
12. **Manual follow-up** - commit and push the version/changelog changes on main

## After Publishing

The script leaves uncommitted changes (bumped versions, updated changelogs, consumed changesets). You must:

```bash
git add -A
git commit -m "chore: version packages"
git push origin main
```

## Adding a Changeset

Before releasing, add a changeset describing your changes:

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

## Why workspace:* Resolution?

This monorepo uses `workspace:*` for internal dependencies. When `changeset publish` runs, it delegates to `npm publish`, which does **not** resolve the `workspace:` protocol. Without the resolution step, published packages would contain literal `workspace:*` references and be broken for consumers.

The release script resolves these to concrete versions (e.g., `workspace:*` becomes `0.1.0-beta.2`) after `changeset version` bumps the versions but before `changeset publish` packs and publishes.

## Prerelease Mode

The repo is in changeset prerelease mode (`beta`). This is tracked in `.changeset/pre.json`. All published versions get a `-beta.N` suffix and are tagged as `beta` on npm, so `npm install @chkit/core` will not install beta versions unless explicitly requested with `@beta`.

To exit prerelease mode (when ready for stable):

```bash
bun run changeset -- pre exit
```
