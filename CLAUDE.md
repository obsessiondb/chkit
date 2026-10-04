# chkit

ClickHouse schema management and migration toolkit for TypeScript.

## Project Structure

This is a monorepo managed with Bun workspaces and Turborepo.

### Main Package (Entry Point)

**`chkit`** (`packages/cli`) is the CLI and the primary distribution package. Its README is the main README shown on npm. All other packages exist to support the CLI or extend it via plugins. When users install chkit, they run `bun add -d chkit`.

### Packages

| Package | npm name | Role |
|---------|----------|------|
| `packages/cli` | `chkit` | **CLI binary and main entry point** |
| `packages/core` | `@chkit/core` | Schema DSL, config, diff engine, migration planner |
| `packages/clickhouse` | `@chkit/clickhouse` | ClickHouse client wrapper (internal) |
| `packages/codegen` | `@chkit/codegen` | Migration artifact generator (internal) |
| `packages/plugin-codegen` | `@chkit/plugin-codegen` | Plugin: TypeScript type + Zod schema generation |
| `packages/plugin-pull` | `@chkit/plugin-pull` | Plugin: introspect live ClickHouse into schema files |
| `packages/plugin-backfill` | `@chkit/plugin-backfill` | Plugin: time-windowed data backfill with checkpoints |
| `packages/plugin-ingest` | `@chkit/plugin-ingest` | Plugin: scheduled pull ingestion with journaled checkpoints |
| `packages/plugin-obsessiondb` | `@chkit/plugin-obsessiondb` | Plugin: ObsessionDB integration; auto-rewrites `Shared` engines for non-ObsessionDB targets |

### Documentation

- Website: https://chkit.obsessiondb.com
- GitHub: https://github.com/obsessiondb/chkit

## Key Conventions

- All packages publish to npm with `homepage: "https://chkit.obsessiondb.com"` and `repository` pointing to the monorepo with the correct `directory`.
- Every package README links to the `chkit` CLI on npm as the entry point and to the documentation website.
- Internal packages (`@chkit/clickhouse`, `@chkit/codegen`) are not meant to be installed directly by users.
- Plugins extend the CLI and are registered in `clickhouse.config.ts` via the `plugins` array.

## Examples

The `examples/` directory holds curated starter projects scaffolded by `create-chkit` (`bun create chkit@latest`). The list shown in the interactive prompt is sourced from `examples/manifest.json`, which is bundled into the `create-chkit` package at build time.

**When you add a new example under `examples/<name>/`, you MUST also add an entry to `examples/manifest.json`.** The `verify` job runs `scripts/check-examples-manifest.ts` (via `create-chkit`'s build step), which fails CI if any directory under `examples/` is missing from the manifest, any manifest entry has no matching directory, or the `default` field doesn't match a listed entry.

## CLI Commands

`init`, `generate`, `migrate`, `status`, `drift`, `check`, `snapshot`, `codegen`, `pull`, `plugin`

All commands support `--json` for machine-readable output and `--config <path>` for custom config files.

## Development

```bash
bun install          # install dependencies
bun run build        # build all packages
bun run test         # run all tests
bun run typecheck    # type-check all packages
bun run lint         # lint all packages
```

## Testing

`bun run test` runs every package's tests, unit and e2e together, through Turbo. Each package's `test` task depends on the root `infra:up` task, which starts the test stack in `test/infra/docker-compose.yml` (ClickHouse 26.3 and a Redpanda Kafka broker) and waits until it is healthy. The stack stays up between runs; `bun run infra:down` removes it. Docker is required.

### Test target

Tests use the local stack unless `CLICKHOUSE_URL` or `CLICKHOUSE_HOST` is set; then `infra:up` starts nothing and the tests run against that server:

- `CLICKHOUSE_HOST` or `CLICKHOUSE_URL` — ClickHouse endpoint
- `CLICKHOUSE_PASSWORD` — required for a remote target
- `CLICKHOUSE_DB` — target database (optional, defaults to `default`)

`bun run test:obsessiondb` runs the suite against ObsessionDB (set the variables above, e.g. through Doppler). It sets `CHKIT_E2E_TARGET=obsessiondb` and leaves out the Kafka suite, whose broker only exists in the local stack.

Shared ClickHouse test utilities (target env, polling, naming) live in `packages/clickhouse/src/e2e-testkit.ts` and are importable via `@chkit/clickhouse/e2e-testkit`. CLI-specific utilities (runner, diagnostics) live in `packages/cli/src/test/e2e-testkit.ts` which re-exports the shared ones. The Kafka suite is the private workspace `test/kafka` (`@chkit/kafka-e2e`). plugin-backfill's `test` script seeds its chunking fixtures before running.

Key conventions:

- **Never skip** — an unreachable server fails the test; never `test.skip()` or silently pass.
- **State-based polling** — use `waitForTable()`, `waitForView()`, `waitForColumn()` instead of blind retry loops. ObsessionDB DDL is eventually consistent.
- **Unique naming** — every test run uses `createPrefix()` / `createJournalTableName()` with timestamps and random suffixes to avoid collisions.
- **Structured diagnostics** — use `formatTestDiagnostic()` for CLI failure messages.

### CI

Turbo orchestrates; GitHub Actions only checks out, installs and calls one script. Keep it that way: no version matrices and no extra jobs.

**verify** runs on every pull request and push to `main`: `bun run verify`, the same command as locally (workspace deps check, `turbo run typecheck lint test build`, packed deps check). Pull requests also get a non-blocking Fallow report.

`test/infra/clickhouse.xml` configures a one-node `cluster` for the backfill status queries, a short query-log flush interval, and Kafka consumers that read topics from the start. The replicated clusters in `test/cluster/` remain opt-in.

After **verify** passes on a push to `main`, **obsessiondb** runs `bun run test:obsessiondb` against the managed test database using the `CLICKHOUSE_HOST`, `CLICKHOUSE_PASSWORD`, and optional `CLICKHOUSE_DB` repository secrets. These runs are serialized because the chunking fixture tables are shared. Deployment waits for both jobs to pass.

After **verify** passes on a same-repository pull request, **deploy** builds and uploads a Cloudflare Pages preview when the PR changes `apps/docs/`, the root package manifest or lockfile, `turbo.json`, or the CI/setup workflow. The preview uses branch `pr-<number>` and has a stable URL at `https://pr-<number>.chkit-docs.pages.dev`, linked in GitHub Deployments and the deploy job summary. Fork and Dependabot PRs do not deploy because they cannot access the Cloudflare repository secrets. Production deployment still runs only on pushes to `main` after both test jobs pass.

A test may skip itself on `CHKIT_E2E_TARGET=obsessiondb` only for a known ObsessionDB limitation with a linked issue, and must still run in **verify**.

`turbo.json` passes through `CHKIT_E2E_TARGET`, `CLICKHOUSE_DB`, `CLICKHOUSE_HOST`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_URL`, and `CLICKHOUSE_USER` to the `test` task. Test results are never cached: both targets must execute the suite, even when the code has not changed.

## Release

Uses changesets. Run `bun run changeset` to create a changeset, then `bun run version-packages` to bump versions.

### Registry integration releases

Keep at most one new release artifact per integration in a PR. Versions already on the merged base are immutable; artifacts added by the unmerged PR are drafts. Further edits refresh that same draft version and its current `meta.chkit.changelog` entry, without adding intermediate versions. Preserve earlier released changelog entries.

Regenerate with `bun run registry:release -- --base origin/main <provider>` and validate with `bun run check:registry-releases -- --base origin/main`; use the actual PR base if different. Omit provider names to refresh all drafts. Do not hand-edit generated artifacts. `bun run verify` checks release history and source/artifact agreement.

### Releasing (GitHub Actions)

Versions are semver; all 10 published packages share one version (a changesets `fixed` group). A release takes two steps, so the version reaches git before npm and any failure can be re-run:

1. **Release: prepare** (`.github/workflows/release-prepare.yml`, manual, repo admins only). Pick `beta` (the next beta) or `stable` (graduates the beta line to GA). It runs `changeset version`, pushes a `release/v<version>` branch, opens a `release: v<version>` PR with the changelog as its body, and starts CI on that branch. A PR opened with `GITHUB_TOKEN` does not trigger `pull_request` runs, so `ci.yml` has a `workflow_dispatch` trigger for this. Re-running prepare refreshes the PR and closes release PRs for other versions.
2. **Merge the release PR.** That is the release decision. **Release: publish** (`.github/workflows/release-publish.yml`) runs on every push to `main`; its `detect` job lets through only a commit whose subject is `release: v<version>` (keep the squash title) or a merge of `release/v<version>`. It runs the quality gates and release guards, publishes with `npm publish`, moves dist-tags, then creates the `v<version>` tag and GitHub release. Beta versions publish under `beta` and move `latest` onto them; stable versions publish straight to `latest`. The publish job also requires an admin: when someone else merged, an admin re-runs it.

Publish refuses a release commit that still has unreleased changesets (changesets merged after prepare), because they would ship without a changelog entry. Re-run prepare to cut the next version. Every step is idempotent: to retry a failed release, re-run its workflow run. A manual dispatch of publish (with an optional `dry_run`) publishes whatever version `main` is at.

Publishing authenticates via **OIDC Trusted Publishing**, so the job runs on a GitHub-hosted runner (`ubuntu-24.04`): Trusted Publishing does not support self-hosted runners, which is how Blacksmith runners register. `bun publish` can't do OIDC, so packages publish with `npm publish --provenance`. `npm publish` copies `workspace:*` into the tarball verbatim, so the script resolves every internal dependency to the current workspace version first (`scripts/workspace-deps.ts`), and `check:packed-deps` packs with `npm pack` after the same resolution. The beta `latest` sync (`npm dist-tag add`) also authenticates via OIDC, which needs npm >= 11.21.0, so the workflow pins `npm@^11.21.0` (npm 12 needs a newer Node than the pinned 22.14.0). No npm token is stored anywhere. The quality gates run `bun run verify` against the local test stack, not the shared ObsessionDB test database.

**One-time setup** (out of band): on each of the 10 packages, add a Trusted Publisher (GitHub Actions → `obsessiondb/chkit` → `release-publish.yml` → environment `release`) and enable **Allow npm dist-tag** on it (off by default; without it a beta release publishes, then fails moving `latest`, and needs a re-run). Create the `release` GitHub environment with deployment branches limited to `main`. Install the pkg.pr.new GitHub App for previews.

**Previews:** `.github/workflows/preview.yml` publishes every push to `main` to pkg.pr.new, not npm: `bun add -d https://pkg.pr.new/chkit@<sha>` (or `@main`).

Without CI: `bun run release:prepare [--stable]` opens the release PR from a clean, up-to-date local `main`, and `bun run release:publish [--dry-run]` publishes the merged release from local `main` (prompts for an npm OTP).
