---
title: "chkit check"
description: "Run policy checks for CI gates covering pending migrations, checksums, drift, and plugins."
sidebar:
  order: 7
---

Evaluates a set of policy checks and exits with code 1 if any fail. Designed as a CI gate to catch problems before deployment.

## Synopsis

```
chkit check [flags]
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--strict` | boolean | `false` | Force all check policies on, regardless of config |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

### Built-in policies

Three policies are evaluated, each defaulting to `true`:

| Policy | Config key | What it checks |
|--------|-----------|----------------|
| Fail on pending | `check.failOnPending` | Pending migrations exist |
| Fail on checksum mismatch | `check.failOnChecksumMismatch` | Applied migration files have been modified |
| Fail on drift | `check.failOnDrift` | Live ClickHouse schema differs from snapshot |

Policies can be disabled in config. The `--strict` flag forces all three on regardless of config values.

### Drift evaluation

Drift is only evaluated when both a `snapshot.json` and a `clickhouse` config block are present. If either is missing, drift is skipped (not treated as a failure).

### Plugin check integration

Plugins can register `onCheck` hooks that return findings with severity levels. If a plugin check has `evaluated: true`, `ok: false`, and at least one finding with `severity: 'error'`, it adds `plugin:<name>` to the list of failed checks.

Built-in plugins that integrate with check:
- [Codegen plugin](/plugins/codegen/#ci--check-integration) — checks generated type freshness
- [Backfill plugin](/plugins/backfill/#ci--check-integration) — checks pending backfill state

### CI gate pattern

```sh
# In your CI pipeline
chkit check --strict --json

# Exit code 0 = all checks pass
# Exit code 1 = one or more checks failed
```

## Examples

**Run all checks with defaults:**

```sh
chkit check
```

**Strict mode (all policies on):**

```sh
chkit check --strict
```

**JSON output for CI:**

```sh
chkit check --json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | All checks pass |
| 1 | One or more checks failed |

## JSON output

```json
{
  "command": "check",
  "schemaVersion": 1,
  "strict": false,
  "policy": {
    "failOnPending": true,
    "failOnChecksumMismatch": true,
    "failOnDrift": true
  },
  "ok": false,
  "failedChecks": ["pending_migrations", "plugin:codegen"],
  "pendingCount": 2,
  "checksumMismatchCount": 0,
  "drifted": false,
  "driftEvaluated": true,
  "driftReasonCounts": {},
  "driftReasonTotals": { "total": 0, "object": 0, "table": 0 },
  "plugins": {
    "codegen": {
      "evaluated": true,
      "ok": false,
      "findingCodes": ["codegen_stale_output"]
    }
  }
}
```

Possible values for `failedChecks`:
- `pending_migrations` — pending migrations exist
- `checksum_mismatch` — applied migration checksums don't match
- `schema_drift` — live schema differs from snapshot
- `plugin:<name>` — a plugin check reported an error

## Related commands

- [`chkit status`](/cli/status/) — view migration state details
- [`chkit drift`](/cli/drift/) — inspect drift details
- [`chkit migrate`](/cli/migrate/) — apply pending migrations to resolve check failures
