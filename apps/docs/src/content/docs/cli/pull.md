---
title: "chkit pull"
description: "Introspect live ClickHouse and generate a TypeScript schema file."
sidebar:
  order: 8
---

Shortcut for `chkit plugin pull schema`. Introspects your live ClickHouse instance and generates a deterministic TypeScript schema file.

## Synopsis

```
chkit pull [flags]
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--out-file <path>` | string | — | Override output file path |
| `--database <db>` | string | — | Limit pull to specific databases (repeat or comma-separate) |
| `--dryrun` | boolean | `false` | Print the operation plan without writing files |
| `--force` | boolean | `false` | Allow overwriting an existing output file |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

This command delegates to the pull plugin's `schema` command. The pull plugin must be registered in your config's `plugins` array with `manifest.name` equal to `"pull"`.

If the pull plugin is not configured, the command fails with:
_"Pull plugin is not configured. Add a plugin with manifest.name "pull" to config.plugins."_

## Examples

```sh
chkit pull --out-file ./src/db/schema/pulled.ts
```

```sh
chkit pull --database analytics --dryrun
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error |
| 2 | Invalid plugin options |

## Related

- [Pull plugin reference](/plugins/pull/) — full documentation for configuration and output format
- [`chkit plugin`](/cli/plugin/) — list and run plugin commands directly
