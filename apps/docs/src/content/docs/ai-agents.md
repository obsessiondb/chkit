---
title: For AI Agents
description: How an AI coding agent should set up and operate chkit on a user's behalf.
sidebar:
  order: 0
---

This page is written for AI coding agents (Claude Code, Cursor, Codex, GitHub Copilot, Windsurf, and others) tasked with adding ClickHouse schema management to a user's project. It tells you what to install, what to recommend, and what not to do unprompted.

chkit is a ClickHouse schema and migration toolkit for TypeScript. Schemas are defined in TypeScript, diffed into migration SQL, applied to ClickHouse, and verified against the live database.

## If a user asked you to set up chkit

1. Install the [agent skill](#install-the-agent-skill) so you have the full command surface, schema DSL, and workflows in context.
2. Run the [setup flow](#manual-setup) to scaffold config and produce the first migration.
3. Pick plugins from the [decision table](#which-plugins-to-recommend) based on what the project needs.
4. Read the [guardrails](#guardrails) before running anything that touches a live database.

## Install the agent skill

chkit ships an installable agent skill that teaches you its commands, schema DSL, and workflows. Install it first — it is the most reliable way to operate chkit correctly:

```sh
skills add obsessiondb/chkit
```

The skill installs into the project's agent directory (for example `.claude/skills/chkit/` or `.cursor/skills/chkit/`). On the first interactive `chkit init`, chkit also detects the active agent and offers to install the skill automatically.

## Manual setup

If the skill is unavailable, drive the setup directly. Install chkit as a dev dependency:

```sh
bun add -d chkit @chkit/core
```

Then run the standard flow:

```sh
chkit init        # scaffold clickhouse.config.ts + a starter schema (idempotent)
chkit generate    # diff schema against the last snapshot → migration SQL
chkit migrate     # plan pending migrations (no changes applied without --apply)
chkit status      # report applied vs pending migrations
chkit check       # CI gate: pending, checksums, drift, plugins
```

`chkit init` writes `clickhouse.config.ts` and `src/db/schema/example.ts`. Edit the example schema to match the table the user actually wants before running `generate`. A ClickHouse endpoint is needed via `CLICKHOUSE_URL` (optionally `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DB`) before any command that talks to the database.

## Which plugins to recommend

Plugins are npm packages registered in the `plugins` array of `clickhouse.config.ts`. Recommend only what the project needs:

| If the project needs to... | Recommend | Notes |
|----------------------------|-----------|-------|
| Adopt chkit on an **existing** ClickHouse database | [`@chkit/plugin-pull`](/plugins/pull/) | Introspects the live database into local schema files so the user starts from real tables, not a blank example. |
| Generate **TypeScript types** (and optional Zod schemas) from the schema | [`@chkit/plugin-codegen`](/plugins/codegen/) | Keeps application row types in sync with the schema definitions. |
| **Backfill** historical data into materialized views | [`@chkit/plugin-backfill`](/plugins/backfill/) | Time-windowed loads with checkpoints, for large or resumable backfills. |
| Deploy to **ObsessionDB** | [`@chkit/plugin-obsessiondb`](/obsessiondb/overview/) | First-class ObsessionDB integration; rewrites `Shared` engines when targeting non-ObsessionDB ClickHouse. |

When the project has none of these needs, the core CLI alone is enough — do not add plugins speculatively.

## Guardrails

chkit applies DDL to real databases. Treat the following as hard rules unless the user explicitly overrides them:

:::caution
- **`migrate` does not apply changes without `--apply`.** Run `chkit migrate` first to plan, show the user the pending SQL, and only then run `chkit migrate --apply`.
- **Verify before applying against anything shared or production.** Run `chkit check` and `chkit drift` first; surface drift to the user rather than silently overwriting it.
- **Generate, then review.** After `chkit generate`, read the migration SQL in `chkit/migrations/` and confirm it matches intent before applying. Migrations are forward-only DDL.
- **Never auto-apply against a production endpoint** without explicit user confirmation. Connection details come from the environment — confirm which database the env points at before `--apply`.
:::

## Machine-readable output

Every command accepts `--json` for structured output you can parse instead of scraping stdout. Use it when you need to act on results programmatically:

```sh
chkit status --json
chkit check --json
chkit migrate --json   # plan as JSON; add --apply to execute
```

Debug logging goes to stderr (`CHKIT_DEBUG=1`), so it never contaminates `--json` output on stdout.

## Prompt to give your user

If a human wants to trigger this setup themselves, they can paste this into their coding agent:

```text
Fetch https://chkit.obsessiondb.com/ai-agents.md and set up chkit schema
management in this repo: install the agent skill, scaffold the config,
recommend any plugins this project needs, and walk me through the first
migration. Don't apply anything against the database without confirming
with me first.
```

Every docs page is available as raw Markdown by appending `.md` to its URL — this page is [`/ai-agents.md`](https://chkit.obsessiondb.com/ai-agents.md). A full machine-readable index lives at [`/llms.txt`](https://chkit.obsessiondb.com/llms.txt).

## Related pages

- [Add to an existing project](/getting-started/add-to-existing-project/) — the human-facing version of the setup flow
- [CLI reference](/cli/overview/) — every command, flag, and JSON output shape
- [Schema DSL](/schema/dsl-reference/) — define tables, views, and materialized views
- [Plugins overview](/plugins/overview/) — how plugins register and hook in
- [CI/CD guide](/guides/ci-cd/) — wire `chkit check` into a pipeline gate
