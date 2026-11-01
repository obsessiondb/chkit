# Changesets

Use Changesets to record package version changes in pull requests.

Do not add package changesets for registry template-only changes or bump `chkit` for them. Use the independent template version, changelog, and generated artifact workflow in [CLAUDE.md](../CLAUDE.md#registry-integration-releases). Shared runtime, CLI, plugin, and library behavior changes still require package changesets; mixed PRs release each affected surface separately.

In prerelease mode, consumed changesets remain on disk and are listed in `pre.json`. Preserve those released entries. When correcting a pending changeset, inspect its original diff and remove only demonstrably template-only package bumps; preserve real package changes and mixed entries.

## Create a changeset

```bash
bun run changeset
```

## Apply version updates locally

```bash
bun run version-packages
```
