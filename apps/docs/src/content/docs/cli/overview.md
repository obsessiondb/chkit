---
title: CLI Overview
description: Command surface of the chkit CLI.
---

## Commands

- `chkit init`
- `chkit generate [--name <migration-name>] [--migration-id <id>] [--config <path>] [--dryrun] [--json]`
- `chkit typegen [--check] [--out-file <path>] [--emit-zod] [--no-emit-zod] [--bigint-mode <string|bigint>] [--include-views] [--config <path>] [--json]`
- `chkit migrate [--config <path>] [--apply|--execute] [--allow-destructive] [--json]`
- `chkit status [--config <path>] [--json]`
- `chkit drift [--config <path>] [--json]`
- `chkit check [--config <path>] [--strict] [--json]`
- `chkit plugin [<plugin-name> [<command> ...]] [--config <path>] [--json]`
- `chkit version`

## Global Flags

- `--config <path>`: config file path (default `clickhouse.config.ts`)
- `--json`: machine-readable output
