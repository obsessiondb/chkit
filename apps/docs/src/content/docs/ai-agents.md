---
title: For AI Agents
description: How an AI coding agent should set up and operate chkit on a user's behalf.
---

This page is written for AI coding agents (Claude Code, Cursor, Codex, GitHub Copilot, Windsurf, and others) tasked with adding ClickHouse schema management to a user's project. It tells you what to ask, what to install, and what not to do unprompted.

If you're a human who landed here, copy the prompt below into your agent — it points the agent back at this page and lets it drive the rest.

## Copy this prompt

Paste this into your coding agent to start setup:

```text
Set up chkit (ClickHouse schema management) in this repo. First fetch
https://chkit.obsessiondb.com/ai-agents.md and follow the instructions there:
ask me the setup questions, install the agent skill, scaffold the config,
recommend any plugins this project needs, and walk me through the first
migration. Don't apply anything to the database without confirming with me first.
```

Every docs page is available as raw Markdown by appending `.md` to its URL — this page is [`/ai-agents.md`](https://chkit.obsessiondb.com/ai-agents.md). A full machine-readable index lives at [`/llms.txt`](https://chkit.obsessiondb.com/llms.txt).

## What chkit is

chkit is a ClickHouse schema and migration toolkit for TypeScript and Python. Schemas are defined in TypeScript or Python, diffed into migration SQL, applied to ClickHouse, and verified against the live database.

You drive chkit with shell commands, plus an installable agent skill that loads its full command surface, schema DSL, and workflows into your context.

## Step 1 — Ask the user before scaffolding

chkit's interactive CLI asks these questions when a human runs it. You run it non-interactively, so you ask them. The answers select which commands you run — ask all three up front, then act. Do not assume answers; if the user just says "set up chkit", ask first.

1. **New project or existing project?**
   - *New / empty directory* → scaffold from a curated example with `create-chkit` (Step 3a).
   - *Existing TypeScript project* → install chkit and run `chkit init` in place (Step 3b).
   - *Existing Python project* → `pip install chkit-py`, then `chkit init` in place (config and schema are written as `.py` files; plugins ship inside chkit-py).

2. **Is there an existing ClickHouse database with tables to manage?**
   - *Yes* → add [`@chkit/plugin-pull`](/plugins/pull/) and introspect the live tables into schema files, so the user starts from real tables instead of the blank example (Step 5).
   - *No* → keep the scaffolded example schema and edit it to match the first table.

3. **How should chkit connect to a database?** — the same four paths as the CLI's connect prompt:
   - *Claim a free ObsessionDB dev instance* — fastest; needs the user's email and a one-time code they receive by email.
   - *Already have an ObsessionDB account* — log in and pick a service.
   - *Already have a ClickHouse instance* — connect with environment variables.
   - *Configure later* — scaffold only; the user wires up the connection themselves.

## Step 2 — Install the agent skill

chkit ships an installable agent skill that teaches you its commands, schema DSL, and workflows. Install it first — it is the most reliable way to operate chkit correctly:

```sh
chkit skills add obsessiondb/chkit
```

The skill installs into the project's agent directory (for example `.claude/skills/chkit/` or `.cursor/skills/chkit/`). On an interactive `chkit init`, chkit also detects the active agent and offers to install the skill automatically.

## Step 3 — Scaffold based on the answers

### 3a. New project — `create-chkit`

`create-chkit` downloads a curated example and wires it to the user's package manager. Pass a target directory and an example to skip the prompts:

```sh
bun create chkit@latest my-chkit-app --example clickbench
```

It then runs the same connect flow as `chkit init` (Step 4). Drive it non-interactively with `--connect <choice>` (and `--email` for the claim path), or `--skip-onboarding` to scaffold only.

### 3b. Existing project — `chkit init`

Install chkit as a dev dependency, then initialize in the current directory:

```sh
bun add -d chkit @chkit/core
chkit init
```

`chkit init` writes `clickhouse.config.ts` and `src/db/schema/example.ts`, and installs any missing chkit packages so the scaffolded config resolves. It is idempotent — re-running it leaves existing files untouched.

Without a TTY, `init` prints the connect runbook (Step 4) instead of prompting. Pass `--yes` to skip onboarding entirely (a silent file-writer for CI), or `--connect <choice>` to drive a specific path.

Edit `src/db/schema/example.ts` to match the table the user actually wants before running `generate` (unless you are pulling from an existing database — see Step 5).

## Step 4 — Connect a database

Map the answer from question 3 to commands. Both `chkit init` and `create-chkit` accept the same flags, so you can drive any path without a TTY:

| Choice | Flag | What to run |
|--------|------|-------------|
| Claim a free ObsessionDB dev instance | `--connect claim --email <you@example.com>` | Two steps — see below. Needs a code emailed to the user. |
| Existing ObsessionDB account | `--connect account` | `chkit obsessiondb login` |
| Existing ClickHouse instance | `--connect clickhouse` | Set `CLICKHOUSE_URL` (and `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DB`) |
| Configure later | `--connect later` or `--yes` | Nothing — scaffold only |

The claim path is two steps and needs a human in the loop, because the code arrives by email:

```sh
chkit obsessiondb signup --email <you@example.com>   # sends a one-time code
# ask the user for the code from their inbox, then:
chkit obsessiondb signup --email <you@example.com> --code <CODE>
chkit obsessiondb service claim                      # provisions the free dev instance
```

Any connected path keeps the `obsessiondb()` plugin registered in `clickhouse.config.ts` — claiming and account login need it for the remote executor, and it rewrites `Shared` engines when targeting non-ObsessionDB ClickHouse.

## Step 5 — Pull existing tables (only if the user has a populated database)

If the user answered yes to question 2, adopt their existing schema instead of the blank example. Add the plugin, register it, and introspect:

```sh
bun add -d @chkit/plugin-pull
# register pull() in the plugins array of clickhouse.config.ts
chkit pull
```

This writes schema files from the live tables, so `generate` diffs against what already exists rather than recreating tables. See [`@chkit/plugin-pull`](/plugins/pull/) for options.

## Step 6 — First migration

Once the schema reflects what the user wants:

```sh
chkit generate --name init   # diff schema against the last snapshot → migration SQL
chkit migrate                # plan pending migrations (nothing is applied)
chkit migrate --apply        # apply — only after the user confirms the SQL
chkit status                 # report applied vs pending migrations
chkit check                  # CI gate: pending, checksums, drift, plugins
```

## Which plugins to recommend

In TypeScript, plugins are npm packages registered in the `plugins` array of `clickhouse.config.ts`; in Python they ship inside chkit-py and are registered in `clickhouse.config.py`. Recommend only what the project needs:

| If the project needs to... | Recommend | Notes |
|----------------------------|-----------|-------|
| Adopt chkit on an **existing** ClickHouse database | [`@chkit/plugin-pull`](/plugins/pull/) | Introspects the live database into local schema files so the user starts from real tables, not a blank example. |
| Generate **typed row models** — TypeScript types (and optional Zod schemas), or Pydantic models in Python — from the schema | [`@chkit/plugin-codegen`](/plugins/codegen/) | Keeps application row types in sync with the schema definitions. |
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

## Related pages

- [Add to an existing project](/getting-started/add-to-existing-project/) — the human-facing version of the setup flow
- [Start with an example](/getting-started/with-an-example/) — scaffold a new project from a curated example
- [CLI reference](/cli/overview/) — every command, flag, and JSON output shape
- [Schema DSL](/schema/dsl-reference/) — define tables, views, and materialized views
- [Plugins overview](/plugins/overview/) — how plugins register and hook in
- [CI/CD guide](/guides/ci-cd/) — wire `chkit check` into a pipeline gate
