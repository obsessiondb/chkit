---
title: Getting Started
description: Install chkit and run the first migration flow.
---

## Prerequisites

- Bun `1.3.5+`
- A ClickHouse endpoint (local Docker, [ClickHouse Cloud](https://clickhouse.com/cloud), or [ObsessionDB](https://obsessiondb.com))

## Install

Add chkit and the core package to your project:

```bash
bun add -d chkit @chkit/core
```

Verify the binary:

```bash
bunx chkit --help
```

## Quick Start

Scaffold config and an example schema:

```bash
bunx chkit init
```

Set your ClickHouse connection (the scaffolded `clickhouse.config.ts` reads these from the environment):

```bash
export CLICKHOUSE_URL=http://localhost:8123
export CLICKHOUSE_USER=default
export CLICKHOUSE_PASSWORD=
export CLICKHOUSE_DB=default
```

Generate, preview, and apply your first migration:

```bash
bunx chkit generate --name init
bunx chkit migrate                # preview pending migrations
bunx chkit migrate --apply        # apply them
bunx chkit status
bunx chkit check
```

## AI Agent Skill

Install the chkit agent skill so AI coding assistants (Claude Code, Cursor, GitHub Copilot, Codex) understand chkit commands, schema DSL, and workflows:

```bash
npx skills add obsessiondb/chkit
```

This installs the skill into your project's agent configuration directory (e.g. `.claude/skills/chkit/`).

## Next

- Continue to [CLI Overview](/cli/overview/)
- Continue to [Config Overview](/configuration/overview/)
- Continue to [Schema DSL Reference](/schema/dsl-reference/)
