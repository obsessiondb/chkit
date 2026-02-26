---
name: pr-creation
description: Use when creating a pull request. Ensures changesets are created for user-facing changes, verification passes, and PR metadata is correct. Invoke this skill BEFORE committing or pushing PR code.
allowed-tools: [Read, Edit, Write, Bash, Glob, Grep, mcp__conductor__GetWorkspaceDiff]
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

## 3. Create Changesets (if needed)

If the PR introduces **any user-facing change** (new feature, bug fix, API change, behavior change):

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

If the PR is purely internal (CI, docs, refactoring with no user-facing effect), a changeset is not required.

## 4. Commit All Changes

Stage and commit all changes including changeset files. Follow any user instructions about commit message style.

## 5. Push and Create PR

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

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## Common Mistakes to Avoid

- **Forgetting changesets**: This is the #1 mistake. Always check if changes are user-facing.
- **Describing only the latest commit**: The PR description should cover the entire branch diff.
