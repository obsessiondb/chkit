---
title: "chkit query"
description: "Run a SQL query against the configured ClickHouse target."
sidebar:
  order: 9
---

Executes an ad-hoc SQL query against the configured target and prints the result.

## Synopsis

```
chkit query "<sql>" [flags]
```

The SQL must be a single positional argument. Wrap it in quotes if it contains spaces.

## Flags

No command-specific flags. See [global flags](/cli/overview/#global-flags).

When the [ObsessionDB plugin](/plugins/obsessiondb/) is loaded, `chkit query`
also accepts `--service <name-or-alias>` to route the query to a specific service for
this invocation (see [Per-command service override](/plugins/obsessiondb/#per-command-service-override)).

## Behavior

`chkit query` runs the SQL through whichever executor is active:

- Without any plugin override, it uses the `clickhouse` connection from your config.
- With the ObsessionDB plugin loaded, it routes the query to the selected service (or to the service named with `--service`).

The command requires an executor — if no `clickhouse` config is present and no plugin supplies one, it exits with an error.

## Examples

```sh
chkit query "SELECT count() FROM users"
```

```
count()
───────
42

(1 row)
```

Override the ObsessionDB service for a single query by service name or saved alias:

```sh
chkit query "SELECT count() FROM users" --service customer-b
```

Machine-readable JSON output:

```sh
chkit query "SELECT count() FROM users" --json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Query executed successfully |
| 1 | Missing SQL, no executor configured, or query failed |

## JSON output

```json
{
  "command": "query",
  "schemaVersion": 1,
  "rowCount": 1,
  "rows": [
    { "count()": "42" }
  ]
}
```

## Related commands

- [`chkit status`](/cli/status/) — show migration state
- [`chkit drift`](/cli/drift/) — compare snapshot to live ClickHouse
