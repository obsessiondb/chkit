---
title: "chkit plugin"
description: "List installed plugins or run plugin commands."
sidebar:
  order: 10
---

Lists registered plugins, lists a plugin's commands, or runs a specific plugin command.

## Synopsis

```
chkit plugin                                    # list all plugins
chkit plugin <plugin-name>                      # list commands for a plugin
chkit plugin <plugin-name> <command> [args...]   # run a plugin command
```

## Flags

No command-specific flags. See [global flags](/cli/overview/#global-flags).

## Behavior

### List all plugins

With no arguments, lists every registered plugin with its name, version, and available commands.

### List plugin commands

With a plugin name, lists the commands available for that plugin with their descriptions.

### Run a plugin command

With both a plugin name and command name, executes the command. Any additional arguments are forwarded to the plugin command handler.

### CLI shortcuts

Some plugins have top-level CLI shortcuts:

- `chkit codegen` is equivalent to `chkit plugin codegen codegen`
- `chkit pull` is equivalent to `chkit plugin pull schema`

### Plugin registration

Plugins are registered in the `plugins` array of `clickhouse.config.ts`. Two registration styles are supported:

1. **Typed inline** — import and call the plugin function directly:
   ```ts
   import { codegen } from '@chkit/plugin-codegen'
   plugins: [codegen({ outFile: './types.ts' })]
   ```

2. **Legacy path-based** — specify a file path to resolve:
   ```ts
   plugins: [{ resolve: './plugins/my-plugin.ts', options: {} }]
   ```

### Plugin lifecycle hooks

Plugins can register hooks that run at various points in the CLI lifecycle:

- `onConfigLoaded` — after config is parsed
- `onSchemaLoaded` — after schema definitions are loaded (can modify definitions)
- `onPlanCreated` — after migration plan is computed (can modify the plan)
- `onBeforeApply` — before migration SQL is executed (can transform statements)
- `onAfterApply` — after migration SQL is executed
- `onCheck` — during `chkit check` evaluation
- `onCheckReport` — for custom check result formatting

## Examples

**List all plugins:**

```sh
chkit plugin
```

**List commands for a specific plugin:**

```sh
chkit plugin backfill
```

**Run a plugin command:**

```sh
chkit plugin backfill plan --target analytics.events --from 2025-01-01 --to 2025-02-01
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | No plugins configured, or plugin/command not found |

## JSON output

### List all plugins

```json
{
  "command": "plugin",
  "schemaVersion": 1,
  "plugins": [
    {
      "name": "codegen",
      "version": "1.0.0",
      "commands": [
        { "name": "codegen", "description": "Generate TypeScript types" }
      ]
    }
  ]
}
```

### List plugin commands

```json
{
  "command": "plugin",
  "schemaVersion": 1,
  "plugin": "backfill",
  "commands": [
    { "name": "plan", "description": "Create a backfill plan" },
    { "name": "run", "description": "Execute a backfill plan" }
  ]
}
```

## Related

- [Codegen plugin](/plugins/codegen/)
- [Pull plugin](/plugins/pull/)
- [Backfill plugin](/plugins/backfill/)
