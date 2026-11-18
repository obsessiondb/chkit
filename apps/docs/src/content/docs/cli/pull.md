---
title: "chkit pull"
description: "Introspect live ClickHouse and generate a schema file."
sidebar:
  order: 8
---

Shortcut for `chkit plugin pull schema`. Introspects your live ClickHouse instance and generates a deterministic schema file (TypeScript, or Python under chkit-py).

## Synopsis

```
chkit pull [flags]
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-o`, `--out-file <path>` | string | — | Override output file path |
| `-d`, `--database <db>` | string | — | Limit pull to specific databases (repeat or comma-separate) |
| `--dryrun` | boolean | `false` | Print the operation plan without writing files |
| `-f`, `--force` | boolean | `false` | Allow overwriting an existing output file |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

This command delegates to the pull plugin's `schema` command. Register the pull plugin in your config's `plugins` array to set its options (`outFile`, `databases`, ...). Without a registration, `chkit pull` runs the installed pull plugin with its defaults, as chkit-py does. A pull plugin registered with `enabled: false` stays off: the command then fails with exit code 1 and _"Pull plugin is not configured. Add it to config.plugins first."_

In chkit-py, `pull` is a built-in command, so there is no plugin to register; `chkit pull schema` and `chkit plugin pull schema` run it too.

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
