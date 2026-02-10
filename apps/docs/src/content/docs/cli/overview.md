---
title: CLI Overview
description: Command surface of the chx CLI.
---

## Commands

- `chx init`
- `chx generate [--name <migration-name>] [--migration-id <id>] [--config <path>] [--dryrun] [--json]`
- `chx typegen [--check] [--out-file <path>] [--emit-zod] [--no-emit-zod] [--bigint-mode <string|bigint>] [--include-views] [--config <path>] [--json]`
- `chx migrate [--config <path>] [--apply|--execute] [--allow-destructive] [--json]`
- `chx status [--config <path>] [--json]`
- `chx drift [--config <path>] [--json]`
- `chx check [--config <path>] [--strict] [--json]`
- `chx plugin [<plugin-name> [<command> ...]] [--config <path>] [--json]`
- `chx version`

## Global Flags

- `--config <path>`: config file path (default `clickhouse.config.ts`)
- `--json`: machine-readable output
