---
date: 2026-03-19T12:51:51+01:00
researcher: Claude
git_commit: 7d15e6fe0bba9d66f4a32258f53a1aea40f23fa2
branch: alvaro/num-6759-obsession-sharedmergetree-migration-race-condition
repository: chkit
topic: "PR #86 CI failure analysis"
tags: [research, ci, plugin-codegen, zod, bun-lockfile]
status: complete
last_updated: 2026-03-19
last_updated_by: Claude
---

# Research: PR #86 CI Failure Analysis

**Date**: 2026-03-19T12:51:51+01:00
**Researcher**: Claude
**Git Commit**: 7d15e6fe0bba9d66f4a32258f53a1aea40f23fa2
**Branch**: alvaro/num-6759-obsession-sharedmergetree-migration-race-condition
**Repository**: chkit

## Research Question

Why does PR #86 ("add DDL propagation wait for SharedMergeTree migrations") fail CI?

## Summary

The CI `verify` job fails because a single test in `@chkit/plugin-codegen` cannot resolve the `zod` package at runtime. The test "emitZod output is valid and can be imported" writes generated code to a temp directory and symlinks `packages/plugin-codegen/node_modules` into it — but `zod` is no longer present at that path after the lockfile was regenerated.

The PR's actual code changes (DDL propagation wait in `packages/clickhouse` and `packages/cli`) are unrelated to this failure. The failure is caused by a lockfile format change that altered Bun's dependency hoisting behavior.

## Detailed Findings

### 1. The Failing Test

**File**: `packages/plugin-codegen/src/index.test.ts:305-340`

The test:
1. Generates TypeScript+Zod code via `generateTypeArtifacts({ emitZod: true })`
2. Creates a temp directory and writes the generated code there
3. **Symlinks** `packages/plugin-codegen/node_modules` → `<tmpdir>/node_modules` (line 331)
4. Dynamically imports the generated file, which does `import { z } from "zod"`
5. The import fails because `zod` is not at `packages/plugin-codegen/node_modules/zod`

Error: `Cannot find package 'zod' from '/tmp/chkit-codegen-zod-kMiJiG/types.ts'`

### 2. The Lockfile Change

Commit `7d15e6f` ("refactor(clickhouse): use p-retry for DDL propagation polling") added `p-retry` as a dependency to `packages/clickhouse`. Running `bun install` locally (Bun 1.2.15) regenerated `bun.lock` with two changes:

1. **Removed `configVersion: 1`** from the lockfile header (lockfile format difference between Bun 1.2.15 and 1.3.5)
2. **Added `p-retry` and `is-network-error`** package entries

The `configVersion` removal changes how Bun 1.3.5 (CI) resolves the hoisting layout. On main's lockfile (with `configVersion: 1`), Bun 1.3.5 hoists `zod` into `packages/plugin-codegen/node_modules/`. With the modified lockfile (no `configVersion`), it doesn't.

### 3. Version Mismatch

| Environment | Bun version | `configVersion` in lockfile | `zod` at `packages/plugin-codegen/node_modules/` | Test passes |
|---|---|---|---|---|
| CI (main) | 1.3.5 | present | yes | yes |
| CI (this PR) | 1.3.5 | absent | no | **no** |
| Local | 1.2.15 | absent | no | **no** |

### 4. CI Run Details

- **Failing run**: https://github.com/obsessiondb/chkit/actions/runs/23246834438/job/67577417278
- **Last passing on main**: run 22944032688 (commit bc78320, "chore: version packages")
- **Result**: 17 pass, 1 fail across 18 tests in `@chkit/plugin-codegen`
- All other test suites pass

### 5. PR Changes (not related to failure)

The PR modifies 8 files — none in `packages/plugin-codegen`:
- `packages/clickhouse/src/ddl-propagation.ts` (new)
- `packages/clickhouse/src/index.ts`
- `packages/clickhouse/package.json` (added `p-retry`)
- `packages/cli/src/bin/commands/migrate.ts`
- `packages/cli/src/clickhouse-live.e2e.test.ts` (new)
- `bun.lock` (regenerated)
- `.changeset/ddl-propagation-wait.md` (new)

## Code References

- `packages/plugin-codegen/src/index.test.ts:305-340` — The failing test
- `packages/plugin-codegen/src/index.test.ts:331` — The symlink that relies on local `node_modules`
- `packages/plugin-codegen/package.json:48` — `zod` declared as devDependency (`^4.3.6`)
- `bun.lock:1-2` — Missing `configVersion` field vs main

## Architecture Documentation

The test relies on Bun's workspace hoisting placing `zod` at `packages/plugin-codegen/node_modules/zod`. This is a devDependency used only for testing the Zod schema generation feature. The symlink approach avoids needing to install packages in the temp directory but is fragile when hoisting behavior changes between lockfile formats or Bun versions.
