---
name: pr-creation
description: Use when creating a pull request. Ensures package changesets and independent registry template releases match the changed surfaces, verification passes, and PR metadata is correct. Invoke this skill BEFORE committing or pushing PR code.
allowed-tools: [Read, Edit, Write, Bash, Glob, Grep, mcp__conductor__GetWorkspaceDiff]
metadata:
  internal: true
---

# PR Creation Checklist

Follow these steps in order when creating a pull request. Do not skip any step.

## 1. Run Verification

```bash
bun verify
```

Do NOT proceed if verification fails. Fix issues first.

## 2. Review the Workspace Diff

Use `mcp__conductor__GetWorkspaceDiff` with `stat: true` to see all changed files, then review the full diff to understand the scope of changes.

## 3. Check Documentation (if needed)

After reviewing the diff, check whether the changes require documentation updates. Ask: "After this change, would the docs be inaccurate or incomplete?"

### Package-to-docs mapping

| Changed package | Docs to check |
|----------------|--------------|
| `packages/cli` | `apps/docs/src/content/docs/cli/<command>.md` for affected commands |
| `packages/core` (config) | `apps/docs/src/content/docs/configuration/overview.md` |
| `packages/core` (schema DSL) | `apps/docs/src/content/docs/schema/dsl-reference.md` |
| `packages/plugin-codegen` | `apps/docs/src/content/docs/plugins/codegen.md`, `cli/codegen.md` |
| `packages/plugin-pull` | `apps/docs/src/content/docs/plugins/pull.md`, `cli/pull.md` |
| `packages/plugin-backfill` | `apps/docs/src/content/docs/plugins/backfill.md` |

### What to update

| Type of change | Update needed |
|---------------|--------------|
| New or changed CLI flag | Flags table in `cli/<command>.md` |
| New CLI command | New `cli/<command>.md` page (use existing command pages as template) |
| Changed command behavior | Behavior section in `cli/<command>.md` |
| Changed exit codes or JSON output | Corresponding sections in `cli/<command>.md` |
| New or changed plugin option | Options section in `plugins/<name>.md` |
| New plugin subcommand | Commands section in `plugins/<name>.md` |
| New config field | `configuration/overview.md` |
| New schema DSL feature | `schema/dsl-reference.md` |

If docs updates are needed, make them in this PR — do not defer to a follow-up. Use the `documentation-authoring` skill for guidance on page templates and formatting conventions.

If the diff already includes appropriate docs changes, or the changes are purely internal with no docs impact, continue to the next step.

## 4. Release Each Changed Surface

Review the whole diff before choosing a release path:

- **Template-only:** Changes to distributed registry source, dependencies, or metadata use the integration's independent version, changelog, and generated release artifact. Do not create a package changeset or bump `chkit` or the fixed npm package group.
- **Package behavior:** User-facing shared-runtime, CLI, plugin, or library changes require ordinary package changesets, even when they support registry templates.
- **Mixed:** Release the affected templates and packages separately. Registry files in a PR never exempt package changes.
- **Docs or tooling only:** No release is needed unless the changed files are distributed as part of a template or change published package behavior.

### Registry template releases

Update `registry/<provider>/manifest.json`: advance `meta.chkit.version` beyond the merged release and add the current `meta.chkit.changelog` entry. Keep at most one new artifact per integration per PR; later edits refresh that same unmerged draft and its changelog entry. Preserve released artifacts and earlier changelog entries.

```bash
bun run registry:release -- --base origin/main <provider>
bun run check:registry-releases -- --base origin/main
```

Use the actual PR base if different. Commit the generated `registry/<provider>/releases/<version>.json` with its source and manifest; never hand-edit generated artifacts. See `CLAUDE.md#registry-integration-releases` and the registry authoring guide for the full workflow.

### Package changesets

If the PR introduces a **user-facing npm package change** (new feature, bug fix, API change, behavior change):

1. Create a changeset file manually at `.changeset/<descriptive-name>.md`
2. The interactive `bun run changeset` CLI does not work in this environment — create the file directly
3. Use this format:

```markdown
---
"package-name": patch|minor|major
---

Short description of the change.
```

4. Look at existing `.changeset/*.md` files for reference on package names and format
5. Choose the bump type:
   - `patch` — bug fixes, internal changes
   - `minor` — new features, non-breaking additions
   - `major` — breaking changes

   **BETA NOTICE:** While chkit is in BETA, **always use `patch`** for all releases regardless of change type.

If the PR is purely internal (CI, docs, refactoring with no user-facing effect), a changeset is not required.

### How to decide: user-facing or internal?

**When in doubt, inspect the changed distribution surface.** An unnecessary package changeset bumps the entire fixed npm group; a missing package changeset delays a real package release.

A package change is **user-facing** if it affects what users experience when they install or run that package. Template code downloaded independently from the registry follows the template release workflow above, not the npm package release.

Examples that **require** a changeset:
- Package bug fixes — even if the fix is in internal/plugin code, if it corrects wrong behavior users can hit, it's user-facing
- New CLI flags, commands, or options
- Changed output format, error messages, or default behavior
- Performance improvements users would notice

Examples that **do NOT require** a changeset:
- Registry template-only changes (use the independent template release workflow instead)
- CI/CD pipeline changes
- Documentation-only changes (docs site, README)
- Dev tooling (linter config, test infra)
- Pure refactors where behavior is identical before and after

## 5. Commit All Changes

Stage and commit all changes including changeset files. Follow any user instructions about commit message style.

## 6. Push and Create PR

1. Push to origin with `-u` flag if the branch has no upstream
2. Use `gh pr create --base main` with:
   - Title under 80 characters
   - Description covering ALL changes in the workspace diff (not just the latest commit)
   - Keep description under five sentences unless instructed otherwise

```bash
gh pr create --base main --title "title here" --body "$(cat <<'EOF'
## Summary
- bullet points describing changes

## Test plan
- [ ] testing steps
EOF
)"
```

## Common Mistakes to Avoid

- **Releasing the wrong surface**: Template-only changes need template releases, not package changesets. Package behavior changes need changesets, including in mixed registry/package PRs.
- **Calling package bug fixes "internal"**: If the code change fixes something that was broken for package users (e.g., wrong file paths, incorrect defaults, broken commands), it needs a changeset — even if only internal files were modified.
- **Describing only the latest commit**: The PR description should cover the entire branch diff.
- **Skipping docs updates**: If a change is user-facing enough to need a changeset, it almost certainly needs a docs update too. New flags, options, commands, and plugin features must be reflected in the corresponding docs page.
