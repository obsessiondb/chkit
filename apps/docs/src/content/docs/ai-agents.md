---
title: Schema Management for AI Agents
description: Set up ClickHouse schema definitions, generate migration SQL, and operate the chkit schema workflow on a user's behalf.
---

Use these instructions to set up chkit in a user's project and prepare the first schema migration.

To delegate setup, paste the prompt below into your coding agent.

## Copy this prompt

Paste this into your coding agent to start setup:

```text
Set up chkit (ClickHouse schema management) in this repo. First fetch
https://chkit.obsessiondb.com/ai-agents.md and follow the instructions there:
use choices I already supplied, ask only missing setup questions, install the agent skill, scaffold the config,
recommend any plugins this project needs, and walk me through the first
migration. Review SQL before applying; ask for apply authorization if I haven't provided it.
```


For an explicitly authorized disposable development target, add:

```text
I authorize the reviewed migrations needed for this task on the supplied
local development database. Proceed through apply and verification without
asking for repeat confirmation. If credentials are missing, prepare everything
possible offline and ask for the exact missing connection values. Do not invent
connection defaults or provision an account.
```

Append `.md` to a documentation URL to read Markdown, such as [`/ai-agents.md`](https://chkit.obsessiondb.com/ai-agents.md). Find page URLs in [`/llms.txt`](https://chkit.obsessiondb.com/llms.txt).

## What chkit is

Use chkit to define ClickHouse schemas, generate migration SQL, deploy reviewed changes, and check the live database for drift. Default to TypeScript unless the user explicitly requests the alpha Python implementation.

Run chkit through shell commands. Install the schema agent skill for command and authoring guidance.

## Step 1: Resolve the setup choices

Treat choices already supplied in the task as answered. Ask only for genuinely missing information, and continue independent offline work while waiting. Use these choices to select the commands.

1. **New project or existing project?**
   - *New / empty directory* → initialize a schema project with `chkit init` in the chosen language (Step 3a).
   - *Existing TypeScript project* → install chkit and run `chkit init` in place (Step 3b).
   - *Existing Python project* → `pip install chkit-py`, then `chkit init` in place (config and schema are written as `.py` files; plugins ship inside chkit-py).

2. **Is there an existing ClickHouse database with tables to manage?**
   - *Yes* → add [`@chkit/plugin-pull`](/plugins/pull/) and introspect the live tables into schema files, so the user starts from real tables instead of the blank example (Step 5).
   - *No* → keep the scaffolded example schema and edit it to match the first table.

3. **How should chkit connect to a database?** Use the CLI's four connection options:
   - *Claim a free ObsessionDB dev instance*: requires the user's email and a one-time code from their inbox.
   - *Already have an ObsessionDB account*: log in and pick a service.
   - *Already have a ClickHouse instance*: connect with environment variables.
   - *Configure later*: scaffold only; the user wires up the connection themselves.

### Missing credentials: prepare offline, then ask

For an existing ClickHouse target, request its HTTP(S) URL including port, username, password (or explicitly blank password), and database. Do not treat localhost, `default`, or an absent password as verified values. Configure direct connected commands to fail clearly when a required value is missing; `generate` can run without a connection/executor.

Prepare schema definitions offline. Generate the initial SQL once the user has chosen the database namespace; if that name is unknown, request it and leave generation pending instead of inventing a default. If a previous attempt generated placeholder SQL, retarget definitions and regenerate only never-applied initial artifacts; never rewrite an applied migration or its history. Keep credentials out of Git and handoffs. Bun loads a root `.env`; npm/Node requires explicit loading such as `node --env-file=.env ./node_modules/chkit/dist/bin/chkit.js check --strict --json`.

The CLI scaffold requires an explicit database namespace before generation and explicit credentials before a direct connection. Preserve supplied target metadata during offline generation; removing the connection configuration can change cluster or engine-setting behavior. A generated config is not proof a database connection works.

## Step 2: Install the agent skill

Install the schema skill with the external `skills` CLI (requires Node.js/npm):

```sh
npx skills add obsessiondb/chkit --skill chkit
```

The skill installs into the project's agent directory (for example `.claude/skills/chkit/` or `.agents/skills/chkit/`). After installing the TypeScript CLI, `chkit skills add obsessiondb/chkit --skill chkit` runs the same installer. On an interactive TypeScript `chkit init`, chkit also detects the active agent and offers to install the skill automatically.

## Step 3: Scaffold based on the answers

### 3a. New project: `chkit init`

For TypeScript, initialize an empty folder:

```sh
mkdir my-chkit-app
cd my-chkit-app
bunx chkit@latest init
```

In an empty directory, `init` writes the config, starter schema, and `package.json`, then installs the required chkit packages.

For Python:

```sh
mkdir my-chkit-app
cd my-chkit-app
pip install chkit-py
chkit init
```

Follow the [first-schema tutorial](/tutorials/first-schema/) for the complete workflow. If the user wants a curated TypeScript project with two tables and an existing migration, use the optional [schema example](/getting-started/with-an-example/).

Both paths offer the connect flow in Step 4. Choose configure-later while credentials are missing; do not claim an account on the user's behalf unless requested. Drive `init` non-interactively with `--connect <choice>` (and `--email` for the claim path), or `--yes` to scaffold only.

### 3b. Existing project: `chkit init`

Install chkit as a dev dependency, then initialize in the current directory:

```sh
bun add -d chkit @chkit/core
chkit init
```

`chkit init` writes `clickhouse.config.ts` and `src/db/schema/example.ts`, and installs missing chkit packages. Running it again preserves existing files.

Without a TTY, `init` prints the connect runbook (Step 4) instead of prompting. Pass `--yes` to skip onboarding in CI, or `--connect <choice>` to drive a specific path.

Edit `src/db/schema/example.ts` to match the requested table before running `generate`. For an existing database, follow Step 5 to import its schema.

## Step 4: Connect a database

Map the answer from question 3 to commands. Both `chkit init` and `create-chkit` accept the same flags, so you can drive any path without a TTY:

| Choice | Flag | What to run |
|--------|------|-------------|
| Claim a free ObsessionDB dev instance | `--connect claim --email <you@example.com>` | Two steps: see below. Needs a code emailed to the user. |
| Existing ObsessionDB account | `--connect account` | `chkit obsessiondb login` |
| Existing ClickHouse instance | `--connect clickhouse` | Set `CLICKHOUSE_URL` (and `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DB`) |
| Configure later | `--connect later` or `--yes` | Nothing: scaffold only |

The claim path is two steps and needs a human in the loop, because the code arrives by email:

```sh
chkit obsessiondb signup --email <you@example.com>   # sends a one-time code
# ask the user for the code from their inbox, then:
chkit obsessiondb signup --email <you@example.com> --code <CODE>
chkit obsessiondb service claim                      # provisions the free dev instance
```

Keep `obsessiondb()` registered in the project config (`clickhouse.config.ts` or `clickhouse.config.py`) for connected paths. Claiming and account login use its remote executor. For non-ObsessionDB ClickHouse targets, the plugin strips the `storage_policy` table setting, since ObsessionDB's storage policies don't exist there.

## Step 5: Pull existing tables (only if the user has a populated database)

If the user answered yes to question 2, import the existing schema. In TypeScript, add the plugin, register it, and introspect:

```sh
bun add -d @chkit/plugin-pull
# register pull() in the plugins array of clickhouse.config.ts
chkit pull
```

In Python, `chkit pull` is built in and needs no plugin registration. Replace or remove the scaffolded starter schema so the configured schema files contain the intended database objects.

Pull writes definitions, not a migration baseline or applied history. Follow [the complete existing-database adoption guide](/getting-started/add-to-existing-project/) to review an idempotent baseline, handle scoped database permissions, apply through the normal journal, verify data/views/live drift, and make a separate ALTER migration. `IF NOT EXISTS` does not prove the existing object matches the definition. Never manufacture history by editing the journal or rebuilding a snapshot. See [schema introspection](/plugins/pull/) for options.

## Step 6: First migration

Once the schema reflects what the user wants:

```sh
chkit generate --name init   # diff schema against the last snapshot → migration SQL
chkit migrate --json         # plan pending migrations without applying
chkit migrate --apply        # apply reviewed SQL with user authorization
chkit status                 # report applied vs pending migrations
chkit check                  # CI gate: pending, checksums, drift, plugins
```

## Which plugins to recommend

In TypeScript, plugins are npm packages registered in the `plugins` array of `clickhouse.config.ts`; in Python they ship inside chkit-py and are registered in `clickhouse.config.py`. Recommend only what the project needs:

| If the project needs to... | Recommend | Notes |
|----------------------------|-----------|-------|
| Adopt chkit on an **existing** ClickHouse database | [`@chkit/plugin-pull`](/plugins/pull/) | Introspects the live database into local schema files so the user starts from real tables, not a blank example. |
| Generate **typed row models**: TypeScript types (and optional Zod schemas), or Pydantic models in Python: from the schema | [`@chkit/plugin-codegen`](/plugins/codegen/) | Keeps application row types in sync with the schema definitions. |
| **Backfill** historical data into materialized views | [`@chkit/plugin-backfill`](/plugins/backfill/) | Partition/sort-key replay with checkpoints; inspect plan predicates and retry/engine semantics. |
| Deploy to **ObsessionDB** | [`@chkit/plugin-obsessiondb`](/obsessiondb/overview/) | ObsessionDB connection and service selection; strips the `storage_policy` table setting when targeting non-ObsessionDB ClickHouse. |

Install plugins for the project's stated requirements.

## Guardrails

chkit applies DDL to real databases. Treat the following as hard rules unless the user explicitly overrides them:

:::caution
- **Preview with `chkit migrate --json`.** This reports pending work without executing migration statements; connected setup can initialize the journal. Review the pending SQL, then apply with the authorization already supplied, or ask if the requested writes are not authorized. For populated structural changes, use [the data-preserving recipe](/guides/data-preserving-migrations/) instead of approving a generated DROP/CREATE. A plain `chkit migrate` in an interactive terminal can prompt to apply the plan.
- **Recover a failed migration with the CLI, not by editing the journal.** Preview with `chkit migrate --retry <file> --json` or `chkit migrate --abandon <file> --json`, show the user the result, and add `--apply` once they confirm. Never delete rows from the `_chkit_migrations` table. See [failed migrations](/cli/migrate/#failed-migrations).
- **Verify before applying against anything shared or production.** Run `chkit check` and `chkit drift` first; surface drift to the user rather than silently overwriting it.
- **Generate, then review.** After `chkit generate`, read the migration SQL in `chkit/migrations/` and confirm it matches intent before applying. Migrations are forward-only DDL.
- **Never auto-apply against a production endpoint** without explicit user confirmation. Connection details come from the environment: confirm which database the env points at before `--apply`.
- **Never resolve a `snapshot.json` merge conflict by taking one side or by editing it by hand.** Resolve the schema files and run `chkit snapshot rebuild`. A conflicted file cannot be compared before the rebuild, so show the user `git diff HEAD -- chkit/meta/snapshot.json` and the same diff against `MERGE_HEAD` (merge) or `REBASE_HEAD` (rebase), and stage the file only once they confirm; until then, `git checkout -m -- chkit/meta/snapshot.json` brings the conflict back. Rebuild only when every schema change has a migration file (`chkit generate --dryrun` reported 0 operations on each branch before the merge); after a chkit upgrade, run `chkit generate` first. Check [when not to rebuild](/cli/snapshot/#when-not-to-rebuild).
:::

## Machine-readable output

Every command accepts `--json` for structured output you can parse instead of scraping stdout. Use it when you need to act on results programmatically:

```sh
chkit status --json
chkit check --json
chkit migrate --json   # plan as JSON; add --apply to execute
```

Read debug logging from stderr (`CHKIT_DEBUG=1`) and `--json` output from stdout.

## Related pages

- [Add to an existing project](/getting-started/add-to-existing-project/): the human-facing version of the setup flow
- [First-schema tutorial](/tutorials/first-schema/): initialize a project, create a table, and deploy a schema change
- [Start with an example](/getting-started/with-an-example/): optional TypeScript starter with two tables and a migration
- [CLI reference](/cli/overview/): every command, flag, and JSON output shape
- [Schema DSL](/schema/dsl-reference/): define tables, views, and materialized views
- [Plugins overview](/plugins/overview/): how plugins register and hook in
- [CI/CD guide](/guides/ci-cd/): wire `chkit check` into a pipeline gate
