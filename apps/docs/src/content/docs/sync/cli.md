---
title: Sync CLI
description: Discover templates and run, inspect, or recover streams with chkit Sync (beta).
---

chkit Sync (beta) uses `chkit registry` to discover templates, `chkit add` to install them, and `chkit sync` to operate exported streams.

## Commands

| Command | Purpose |
|---|---|
| [`chkit registry list`](/cli/registry/) | Browse available provider templates and their coverage |
| [`chkit registry inspect <name>`](/cli/registry/) | Inspect credential setup, destination tables, copied files, and dependencies |
| [`chkit registry build`](/cli/registry/) | Build versioned template artifacts for a custom registry |
| [`chkit add <name>`](/cli/add/) | Copy an editable provider template into a TypeScript project |
| [`chkit sync list`](/cli/sync/) | List exported streams and their selection tags |
| [`chkit sync run`](/cli/sync/) | Execute selected streams once |
| [`chkit sync status`](/cli/sync/) | Read stream checkpoints from the configured journal |
| [`chkit sync doctor`](/cli/sync/) | Diagnose selected journal histories |
| [`chkit sync repair`](/cli/sync/) | Preview or materialize a reviewed journal repair |

`chkit sync <subcommand>` is an alias for `chkit plugin sync <subcommand>` and requires the Sync plugin in `clickhouse.config.ts`. Registry browsing does not require a project config or database connection.

## First run

Inspect and install a template in a TypeScript project:

```sh
bunx chkit registry inspect attio
bunx chkit add attio --with-tests
```

Configure the provider credentials and direct ClickHouse connection as described in the [integration guide](/integrations/attio/). Create destination tables through chkit Schema, reviewing the generated SQL before applying it:

```sh
bunx chkit sync list
bunx chkit generate --name add-attio
bunx chkit migrate --json
bunx chkit migrate --apply
bunx chkit sync run --tag provider:attio
bunx chkit sync status --tag provider:attio
```

`generate` and `migrate` belong to [chkit Schema](/cli/overview/); they prepare the destination schema. Template installation does not run migrations, access the provider, or schedule future runs.

## Shared flags

The CLI shares [global flags](/cli/overview/#global-flags), including `--config` and `--json`. Each command reference documents its own flags and output. Use `--tag` on ingestion commands to select streams; repeat it to require every supplied tag.

## Related pages

- [chkit Sync (beta)](/sync/): product scope and starting points.
- [`chkit sync`](/cli/sync/): stream flags, exit codes, and JSON output.
- [`chkit add`](/cli/add/): installation, ownership, and conflicts.
- [`chkit registry`](/cli/registry/): template discovery and publishing commands.
- [Scheduling and recovery](/api-sync/operations/): recurring runs and recovery workflows.
