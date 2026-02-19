---
title: CI/CD Integration
description: Run chkit schema validation, migration deployment, and type checking in continuous integration pipelines.
---

chkit is designed to run unattended in CI pipelines. Every command supports a `--json` flag for machine-readable output, and the CLI automatically detects non-interactive environments so it never blocks on prompts.

Three primary CI use cases:

1. **Schema validation gate** — run `chkit check` and `chkit codegen --check` on every pull request to catch drift, stale types, and pending migrations before merge.
2. **Automated migration deployment** — run `chkit migrate --apply` on merge to main to apply pending migrations to staging or production ClickHouse.
3. **JSON output scripting** — parse structured output with `jq` to build custom notifications, dashboards, or approval gates.

## CI-relevant commands

| Command | CI usage | Key flags | Exit codes |
|---|---|---|---|
| `chkit check` | Validate schema consistency | `--strict`, `--json` | 0 = pass, 1 = fail |
| `chkit codegen --check` | Verify generated types are current | `--json` | 0 = current, 1 = stale |
| `chkit migrate --apply` | Apply migrations non-interactively | `--allow-destructive`, `--json` | 0 = ok, 1 = error, 3 = destructive blocked |
| `chkit status` | Report migration state | `--json` | 0 |
| `chkit drift` | Compare snapshot vs live schema | `--json` | 0 |

## Environment variables

chkit reads ClickHouse connection details from the environment. Set these as CI secrets:

| Variable | Purpose |
|---|---|
| `CLICKHOUSE_URL` | ClickHouse HTTP(S) endpoint |
| `CLICKHOUSE_USER` | Username |
| `CLICKHOUSE_PASSWORD` | Password |
| `CLICKHOUSE_DB` | Target database |

### Non-interactive detection

The CLI detects CI environments automatically. A command is considered non-interactive when any of these are true:

- `process.env.CI` is `'1'` or `'true'` (set by GitHub Actions, GitLab CI, and most CI providers)
- `process.stdin.isTTY` is falsy
- `process.stdout.isTTY` is falsy

When non-interactive, `chkit migrate` without `--apply` prints the migration plan and exits without prompting. Pass `--apply` explicitly to execute.

### Dynamic config for CI

Your `clickhouse.config.ts` can export a function that receives a `ChxConfigEnv` object with `command` and `mode` fields. Use this to vary config per environment:

```ts
import { defineConfig } from 'chkit'

export default defineConfig((env) => ({
  schema: './schema/**/*.ts',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: process.env.CLICKHOUSE_DB ?? 'default',
  },
}))
```

## Check policies

The `chkit check` command evaluates three policies:

| Policy | Default | Effect when enabled |
|---|---|---|
| `failOnPending` | `true` | Fail if unapplied migrations exist |
| `failOnChecksumMismatch` | `true` | Fail if applied migration files were modified |
| `failOnDrift` | `true` | Fail if live schema drifts from snapshot |

All three default to `true`, so checks are strict out of the box. Override them in `clickhouse.config.ts`:

```ts
export default defineConfig({
  schema: './schema/**/*.ts',
  check: {
    failOnPending: true,
    failOnChecksumMismatch: true,
    failOnDrift: false, // disable drift checking
  },
})
```

The `--strict` flag forces all three policies to `true`, overriding any config. **Use `--strict` in CI** to ensure no permissive config setting leaks through.

Plugin checks (like `codegen`) are also evaluated automatically — a plugin is considered failed when it reports at least one finding with `severity: 'error'`.

## GitHub Actions: schema validation on PRs

```yaml
name: Schema Validation
on: pull_request

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.3.5'

      - run: bun install --frozen-lockfile

      - name: Check schema consistency
        run: bunx chkit check --strict --json

      - name: Verify generated types
        run: bunx chkit codegen --check --json
```

This workflow runs on every pull request. Both commands exit with code 1 on failure, which fails the GitHub Actions step.

## GitHub Actions: migration deployment on merge

```yaml
name: Deploy Migrations
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLICKHOUSE_URL: ${{ secrets.CLICKHOUSE_URL }}
      CLICKHOUSE_USER: ${{ secrets.CLICKHOUSE_USER }}
      CLICKHOUSE_PASSWORD: ${{ secrets.CLICKHOUSE_PASSWORD }}
      CLICKHOUSE_DB: ${{ secrets.CLICKHOUSE_DB }}

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.3.5'

      - run: bun install --frozen-lockfile

      - name: Apply migrations
        run: bunx chkit migrate --apply --json
```

:::caution
This workflow does **not** pass `--allow-destructive`. If a migration contains destructive operations (dropping tables or columns), the command exits with code 3 and the deployment stops. See [Handling destructive migrations](#handling-destructive-migrations-in-ci) for how to handle this safely.
:::

## GitLab CI

```yaml
stages:
  - validate
  - deploy

.bun-setup: &bun-setup
  image: oven/bun:1.3.5
  before_script:
    - bun install --frozen-lockfile

schema-check:
  <<: *bun-setup
  stage: validate
  script:
    - bunx chkit check --strict --json
    - bunx chkit codegen --check --json
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

deploy-migrations:
  <<: *bun-setup
  stage: deploy
  script:
    - bunx chkit migrate --apply --json
  variables:
    CLICKHOUSE_URL: $CLICKHOUSE_URL
    CLICKHOUSE_USER: $CLICKHOUSE_USER
    CLICKHOUSE_PASSWORD: $CLICKHOUSE_PASSWORD
    CLICKHOUSE_DB: $CLICKHOUSE_DB
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

## Generic CI setup

For any CI system, use this shell script:

```bash
#!/usr/bin/env bash
set -euo pipefail

bun install --frozen-lockfile

# Validate schema
bunx chkit check --strict --json
bunx chkit codegen --check --json

# Deploy on main branch only
if [ "${BRANCH:-}" = "main" ]; then
  bunx chkit migrate --apply --json
fi
```

## Handling destructive migrations in CI

When `chkit migrate --apply` encounters migrations that drop tables, drop columns, or perform other destructive operations, it exits with **code 3** instead of applying them. This is a safety gate — destructive changes require explicit opt-in.

### What triggers exit code 3

The CLI scans pending migration SQL for dangerous operations. When found and `--allow-destructive` is not passed, the command:

- In `--json` mode: emits an error payload with `destructiveMigrations` and `destructiveOperations` arrays, then exits with code 3
- In text mode: prints destructive operation details and exits with an error

### Safety gate pattern

**Never pass `--allow-destructive` by default.** Instead, use a two-step workflow:

1. **PR check** — `chkit check --strict` surfaces destructive operations during review
2. **Deploy step** — `chkit migrate --apply` blocks on destructive ops, requiring manual approval

### Destructive operation JSON payload

Each entry in the `destructiveOperations` array contains:

| Field | Description |
|---|---|
| `migration` | Migration file name |
| `type` | Operation type (e.g., `drop_table`, `drop_column`) |
| `key` | Affected object identifier |
| `risk` | Risk level (`danger`) |
| `warningCode` | Machine-readable warning code |
| `reason` | Human-readable explanation |
| `impact` | Description of data impact |
| `recommendation` | Suggested action |
| `summary` | One-line summary |

### GitHub Actions manual approval gate

Add a manual approval step before allowing destructive migrations:

```yaml
name: Deploy Migrations
on:
  push:
    branches: [main]

jobs:
  migrate:
    runs-on: ubuntu-latest
    env:
      CLICKHOUSE_URL: ${{ secrets.CLICKHOUSE_URL }}
      CLICKHOUSE_USER: ${{ secrets.CLICKHOUSE_USER }}
      CLICKHOUSE_PASSWORD: ${{ secrets.CLICKHOUSE_PASSWORD }}
      CLICKHOUSE_DB: ${{ secrets.CLICKHOUSE_DB }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.3.5'
      - run: bun install --frozen-lockfile

      - name: Apply safe migrations
        id: migrate
        run: bunx chkit migrate --apply --json
        continue-on-error: true

      - name: Check for destructive block
        if: steps.migrate.outcome == 'failure'
        run: |
          if [ "${{ steps.migrate.outputs.exitcode }}" = "3" ]; then
            echo "::error::Destructive migrations detected. Approve the environment deployment to proceed."
            exit 1
          fi
          echo "::error::Migration failed with a non-destructive error."
          exit 1

  migrate-destructive:
    needs: migrate
    if: failure()
    runs-on: ubuntu-latest
    environment: production  # Requires manual approval in GitHub settings
    env:
      CLICKHOUSE_URL: ${{ secrets.CLICKHOUSE_URL }}
      CLICKHOUSE_USER: ${{ secrets.CLICKHOUSE_USER }}
      CLICKHOUSE_PASSWORD: ${{ secrets.CLICKHOUSE_PASSWORD }}
      CLICKHOUSE_DB: ${{ secrets.CLICKHOUSE_DB }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.3.5'
      - run: bun install --frozen-lockfile

      - name: Apply with destructive allowed
        run: bunx chkit migrate --apply --allow-destructive --json
```

The `environment: production` line requires manual approval in GitHub's environment protection rules before the destructive migration job runs.

## JSON output for CI scripts

All commands wrap their output in a standard envelope when `--json` is passed:

```json
{
  "command": "check",
  "schemaVersion": 1,
  ...
}
```

The `command` field identifies which command produced the output. The `schemaVersion` field (currently `1`) tracks the output contract version for forward compatibility.

### Parsing with jq

**Check pass/fail:**

```bash
result=$(bunx chkit check --strict --json)
ok=$(echo "$result" | jq -r '.ok')
if [ "$ok" != "true" ]; then
  echo "Check failed:"
  echo "$result" | jq '.failedChecks'
  exit 1
fi
```

**Pending migration count:**

```bash
pending=$(bunx chkit status --json | jq '.pending')
echo "Pending migrations: $pending"
```

**Destructive operation details:**

```bash
bunx chkit migrate --apply --json 2>&1 || true
# If exit code 3, parse destructive details:
bunx chkit migrate --apply --json | jq '.destructiveOperations[] | {migration, type, key, impact}'
```

## Complete combined workflow

A production-ready GitHub Actions workflow with validation and deployment as separate jobs:

```yaml
name: Schema CI/CD
on:
  pull_request:
  push:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.3.5'

      - run: bun install --frozen-lockfile

      - name: Schema check
        run: bunx chkit check --strict --json

      - name: Type check
        run: bunx chkit codegen --check --json

  deploy:
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    needs: validate
    runs-on: ubuntu-latest
    env:
      CLICKHOUSE_URL: ${{ secrets.CLICKHOUSE_URL }}
      CLICKHOUSE_USER: ${{ secrets.CLICKHOUSE_USER }}
      CLICKHOUSE_PASSWORD: ${{ secrets.CLICKHOUSE_PASSWORD }}
      CLICKHOUSE_DB: ${{ secrets.CLICKHOUSE_DB }}

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.3.5'

      - run: bun install --frozen-lockfile

      - name: Apply migrations
        run: bunx chkit migrate --apply --json
```

The `validate` job runs on both PRs and pushes. The `deploy` job runs only on pushes to `main` and waits for `validate` to pass first.

## Tips and troubleshooting

**No Docker required** — Bun runs natively on Linux CI runners. For Docker-based CI, use the `oven/bun:1.3.5` image.

**Non-interactive auto-detection** — The CLI never prompts in CI. If you see unexpected prompts, ensure `CI=true` is set or that stdin is not a TTY.

**Always use `--frozen-lockfile`** — Prevents `bun install` from modifying `bun.lock` during CI runs.

**Custom config path** — If your config file is not at the project root, pass `--config path/to/clickhouse.config.ts`.

**Drift requires a live connection and snapshot** — `chkit drift` compares the snapshot file against the live ClickHouse schema. It needs both a snapshot (generated by `chkit generate`) and a reachable ClickHouse instance with credentials configured.
