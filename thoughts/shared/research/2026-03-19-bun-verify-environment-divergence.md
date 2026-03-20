---
date: 2026-03-19T13:34:47+01:00
researcher: Claude
git_commit: aa45c6e7b84fc5bc53fc22e7c7e6eefbbe763bce
branch: alvaro/num-6759-obsession-sharedmergetree-migration-race-condition
repository: chkit
topic: "Why does bun verify break for one developer but work for another?"
tags: [research, codebase, verify, environment, doppler, bun, clickhouse]
status: complete
last_updated: 2026-03-19
last_updated_by: Claude
---

# Research: Why does `bun verify` break for one developer but work for another?

**Date**: 2026-03-19T13:34:47+01:00
**Researcher**: Claude
**Git Commit**: aa45c6e7b84fc5bc53fc22e7c7e6eefbbe763bce
**Branch**: alvaro/num-6759-obsession-sharedmergetree-migration-race-condition
**Repository**: chkit

## Research Question

`bun verify` breaks for me, but the exact same version works for a coworker. Why?

## Summary

`bun verify` has **five categories** of environment-dependent behavior that can cause it to succeed for one developer and fail for another, even on the same commit. The most likely culprits are **Doppler configuration**, **Bun version mismatch**, and **Turborepo caching**. Below is a complete inventory of every divergence point.

## Detailed Findings

### 1. Doppler — The First Gate

The `verify` script (`package.json:28`) is:

```
doppler run --project chkit --config ci -- turbo run typecheck lint test build
```

This requires **Doppler CLI installed and authenticated** with access to the `chkit` project, config `ci`. If Doppler is not installed, not logged in, or the developer doesn't have access to the `chkit/ci` config, the command fails immediately before any Turbo task runs.

**What to check**: Run `doppler configs` in the repo — both developers should see the `ci` config for the `chkit` project.

### 2. Bun Version — No Enforcement Locally

| Where | Version |
|-------|---------|
| `package.json:13` (`packageManager`) | `bun@1.3.5` |
| CI (`.github/actions/setup/action.yml:8`) | `1.3.5` (exact) |
| Local machine | Whatever is installed |

There is **no `.tool-versions`**, **no `.nvmrc`**, and **no `engines` field** in any `package.json`. A developer running Bun 1.2.x or 1.4.x could see different behavior in:
- `bun test` runner behavior
- `bun install` dependency resolution
- TypeScript transpilation
- Module resolution (`import.meta.dir`, conditional exports)

**What to check**: Both developers should run `bun --version` and compare.

### 3. ClickHouse E2E Tests — Hard-Fail on Missing Credentials

The `bun test src` command in every package runs **all** `*.test.ts` files, including `*.e2e.test.ts`. There is no glob filter or directory split to exclude E2E tests.

E2E tests call `getRequiredEnv()` (`packages/clickhouse/src/e2e-testkit.ts:25-42`) which **throws** (not skips) if:
- Neither `CLICKHOUSE_URL` nor `CLICKHOUSE_HOST` is set
- `CLICKHOUSE_PASSWORD` is empty

Doppler is the mechanism that injects these for `bun run verify`. If Doppler injects different values (wrong host, expired password) for one developer, E2E tests will fail.

**10 E2E test files** require live ClickHouse credentials — they all hard-fail without them.

### 4. Turborepo Caching — Silent Success

Turbo caches task results (including `test`). The `test` cache key includes:
- Source file hashes
- The five `passThroughEnv` variables: `CLICKHOUSE_DB`, `CLICKHOUSE_HOST`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_URL`, `CLICKHOUSE_USER`

If a developer's Turbo cache (`node_modules/.cache/turbo`) contains a cached pass for `test` from a previous run, `bun verify` may report success **without actually running tests**. Meanwhile, a developer without that cache (or with different env vars invalidating the cache) runs the tests fresh and hits failures.

**What to check**: Run `turbo run test --force` to bypass the cache and see if the failure reproduces.

### 5. Build Artifacts and `dist/` Stale State

The `test` task depends on `^build` — upstream packages must build first. Turbo caches build artifacts in `dist/**`. If a developer has stale `dist/` directories from a previous branch/commit that don't match the current source, tests importing from those packages may see incorrect behavior.

**What to check**: Run `rm -rf packages/*/dist && bun run verify` to rebuild from scratch.

### 6. Lock File Divergence

CI runs `bun install --frozen-lockfile` and then `git diff --exit-code bun.lock` to ensure the lockfile matches. Locally, developers run plain `bun install`, which can modify `bun.lock` if the installed Bun version resolves dependencies differently.

If one developer accidentally has a modified lockfile (different dependency versions), they could see different behavior.

**What to check**: `git diff bun.lock` — it should be clean.

## Other Documented Differences (Less Likely Causes)

| Factor | Notes |
|--------|-------|
| OS | All developers are on macOS; no platform-specific code exists |
| Git hooks | None configured |
| TTY detection | Only affects `migrate` command prompts, not test outcomes |
| `test.skipIf` | Only one instance, date-based (skipped until 2026-06-01), same for everyone |
| Test timeouts | E2E tests use 240s timeouts; unlikely to differ unless ClickHouse is unreachable |

## Diagnostic Checklist

1. `doppler configs` — Is the `chkit/ci` config accessible?
2. `bun --version` — Is it `1.3.5`?
3. `git diff bun.lock` — Is the lockfile clean?
4. `turbo run test --force` — Does the failure reproduce without cache?
5. `rm -rf packages/*/dist && bun run verify` — Does a clean build fix it?
6. `doppler run --project chkit --config ci -- env | grep CLICKHOUSE` — Are credentials populated?

## Code References

- `package.json:28` — `verify` script definition
- `turbo.json:14-22` — `test` task with `passThroughEnv`
- `packages/clickhouse/src/e2e-testkit.ts:25-42` — `getRequiredEnv()` hard-fail logic
- `.github/actions/setup/action.yml:8` — Bun version pin (`1.3.5`)
- `.github/workflows/ci.yml:19-20` — Lock file integrity check
- `package.json:13` — `packageManager: bun@1.3.5`

## Architecture Documentation

The verify pipeline is: `Doppler (secrets) → Turbo (orchestrator) → bun (runner)`. Each layer can independently cause divergence between developers. Doppler must be configured per-developer. Turbo caching is per-machine. Bun version is unmanaged locally.
