---
name: chkit-tinybird
description: Move a Tinybird project to chkit. Use when the user asks to bring Tinybird datasources, materialized views, copy pipes or endpoints into chkit, to migrate off Tinybird, or to generate a chkit schema from Tinybird datafiles (.datasource, .pipe, tinybird.config.json). Covers installing chkit and @chkit/plugin-tinybird, finding the Tinybird project, the import, the objects it cannot translate, and applying the result.
allowed-tools: [Read, Edit, Write, Grep, Glob, Bash]
---

# Tinybird to chkit

`@chkit/plugin-tinybird` reads a Tinybird Forward project from disk and writes a chkit schema that creates, on plain ClickHouse, the objects Tinybird creates: datasources as tables, materialized pipes as materialized views, copy pipes as refreshable materialized views, and simple endpoints as typed queries. The translation is deterministic and checked against Tinybird; never rewrite its output by hand. Your job is everything around it: setup, finding the project, the decisions only the user can make, and what the plugin reports as not translated.

Work in phases and finish each before the next. Tell the user which phase you are in, what you found and what you need from them. Reuse what the user already said; ask only for what is missing, and batch your questions into as few messages as the phases allow.

Docs: https://chkit.obsessiondb.com/plugins/tinybird/

## Rules for the whole task

- You never run Tinybird commands: no `tb`, no Tinybird CLI install, no calls to the Tinybird API. The Tinybird account, its credentials and its CLI belong to the user. When something must come from Tinybird (the project datafiles, usage stats, the SQL of an endpoint), give the user the exact steps, wait for them to run them, and work from the folder or output they give you.
- Never suggest `tb deploy`, `tb migrate-to-forward`, `tb push`, `tb datasource truncate`/`delete` or anything else that changes a Tinybird workspace; this move does not need them.
- Never ask for Tinybird tokens or ClickHouse passwords in the chat. Keep credentials out of every file you write except an ignored `.env`; check the ignore rules before writing one.
- Follow the `chkit` skill for the ClickHouse target: never guess the URL, user, password or database, and get authorization before `chkit migrate --apply`.
- The plugin overwrites its output files on the next import. Put every hand-written replacement in separate files.

## Phase 1: Look around, then ask once

Read before you ask anything, then put every question of this phase in one message.

1. **chkit.** Look for an existing chkit project: a `clickhouse.config.ts` with `chkit` in the nearest `package.json`. If there is one, its folder is the chkit root and its `schema` glob decides where schema files go; there is nothing to ask about the layout.
2. **Tinybird.** Search the repository, skipping `node_modules`, `.git` and virtualenvs, for `tinybird.config.json` and for `*.datasource` / `*.pipe` files. Group them by the folder that holds `tinybird.config.json`, or by their common parent folder. For each candidate note its path, Forward (has `tinybird.config.json`) or Classic (datafiles without it), datasource and pipe counts, a few datasource names, and when its files last changed in git. A `.tinyb` file names the workspace (`name` and `host` only, never the token), but git usually ignores it, so expect it to be missing.
3. **Ask, in one message:**
   - **Where chkit lives**, only when there is no chkit project yet. `chkit init` writes into the folder it runs in, so this choice is the layout. Offer what fits the repository:
     - **Repository root**: when the repository is one TypeScript app that will call the queries itself.
     - **A dedicated folder**, for example `clickhouse/` or `db/` (in a workspace monorepo, `packages/clickhouse`): when the repository is a monorepo, is not TypeScript, or the user wants the database code apart. The folder gets its own `package.json`; in a workspace monorepo, add it to the workspaces.

     Show the layout the import produces, with the user's folder names:

     ```text
     <chkit root>/
     ├── clickhouse.config.ts       # chkit config: schema glob, plugins, connection read from env
     ├── package.json               # chkit, @chkit/core and @chkit/plugin-tinybird as devDependencies
     ├── .gitignore                 # node_modules/ and .env, when the folder is new
     ├── .env                       # CLICKHOUSE_URL/USER/PASSWORD/DB, ignored by git
     ├── src/db/
     │   ├── schema/
     │   │   ├── tinybird.ts        # written by the import; never edit, it is overwritten
     │   │   └── tinybird-manual.ts # your replacements for what did not translate
     │   └── queries/
     │       ├── tinybird.ts        # endpoints as typed queries, written by the import
     │       └── tinybird-manual.ts # endpoints rewritten by hand
     └── chkit/
         ├── migrations/            # SQL migrations from chkit generate
         ├── meta/snapshot.json     # what the migrations already cover
         └── tinybird-import.json   # import report
     ```

     Change the paths only if the user asks; the defaults match what `chkit init` scaffolds.
   - **Which Tinybird project is the target.** List the candidates. A repository often holds an old copy, an example or another environment, so ask even when there is one, and offer "none of these". If the user picks several (for example production, staging, testnet), import them one at a time, each to its own output files.
   - **Whether it is up to date with the workspace.** The import reads only these files; whatever was changed in the Tinybird UI or deployed from elsewhere is missing until the files are refreshed. If the user is not sure, offer the pull steps below into a new folder, so their copy stays untouched.
   - **Which workspace it came from**, when no `.tinyb` says so. The answer is a good default for the database name in Phase 3.
4. **Classic, nothing found, "none of these" or not up to date.** The plugin reads Forward projects only; Classic datafiles use directives Forward dropped (`IMPORT_SERVICE`, BigQuery imports, `INCLUDE`, `VERSION`). Give the user these steps to run themselves. They follow Tinybird's guide (https://www.tinybird.co/docs/forward/guides/migrate-from-classic) up to the pull, which is all the import needs:
   1. Install the Tinybird **Forward** CLI (package `tinybird`, version 4.6.4 or later) as Tinybird's docs describe. If they also have the Classic CLI (`tinybird-cli`), both are called `tb`: keep the Forward one apart, for example `uvx --from tinybird@latest tb …` or its own virtualenv.
   2. Authenticate against the workspace to import (`tb login`).
   3. In a new empty folder (inside the chkit folder, for example `tinybird/`, keeps things together), run `tb --cloud pull`. It downloads the definitions only, never data, and works on Classic workspaces too.
   4. Do not run `tb migrate-to-forward` or any deploy: they change the workspace permanently and this move does not need them.
   5. Tell you the folder path.

   Then wait. When the user gives you the folder, check it holds `tinybird.config.json` and datafiles, and continue. If the session ended, the user can run this skill again with the folder path.

## Phase 2: Install

1. **Install before `chkit init`, all packages at once**, in the chkit root, with the package manager the repository uses (its lockfile decides): `bun add -d chkit @chkit/core @chkit/plugin-tinybird` (or `npm i -D …`, `pnpm add -D …`). `chkit init` installs packages itself whenever it cannot load `@chkit/core` from the folder, and that can rewrite the versions already in `package.json`; installing `@chkit/core` first avoids it. All chkit packages share one version: check they match.
2. **TypeScript project without chkit:** run `chkit init` in the chkit root (`bunx chkit init`, `npx chkit init`). Use the `chkit` skill for its choices. When the user is not connecting to ObsessionDB now, `chkit init --yes` skips the connection prompts. Afterwards, check `package.json` still holds the versions you installed.
3. **Python project (`chkit-py`):** the Tinybird plugin is TypeScript only. Tell the user and offer the dedicated TypeScript folder from Phase 1 just for the import, or stop.
4. Remove the scaffolded `src/db/schema/example.ts` with the user's agreement, so the first migration holds only Tinybird objects.
5. In a new folder, add a `.gitignore` with `node_modules/` and `.env` unless the repository's ignore rules already cover them there.
6. If every chkit command prints `obsessiondb: authenticated but no service selected`, the ObsessionDB plugin found a login on this machine. It is harmless when the target is not ObsessionDB; say so once if the user asks.

## Phase 3: Decide and configure

Ask the user, in one message:

- **Target database name**: the name of the ClickHouse database where every imported table and view is created, for example `analytics`, `tinybird` or the workspace name from Phase 1. It goes into each definition, so it is the database the migrations create objects in and the one your queries read. Suggest the workspace name when you know it, but let the user choose; do not invent one and do not assume `default`. If the user already has a ClickHouse database for this, use its exact name.
- **Scope**: import everything, or only what is still used. Pruning is worth it for large or old projects (Phase 4).
- **Endpoints**: does an application call the Tinybird endpoints over HTTP, and which ones? chkit turns endpoints into typed query functions, not URLs; serving them needs an API layer (Phase 7). Knowing which endpoints are called decides Phase 6.

Then register the plugin in `clickhouse.config.ts`:

```ts
import { tinybird } from '@chkit/plugin-tinybird'

// inside defineConfig
plugins: [
  tinybird({
    project: './tinybird',                       // folder from Phase 1
    database: 'analytics',                       // from the user
    outFile: './src/db/schema/tinybird.ts',
    queriesOutFile: './src/db/queries/tinybird.ts',
    reportFile: './chkit/tinybird-import.json',
  }),
],
```

Paths are relative to the chkit root. `outFile` must be matched by the config's `schema` glob (or re-exported from its `entry`); otherwise `chkit generate` never sees the tables. Check the glob and adjust `outFile`, not the glob. Keep `queriesOutFile` outside the schema glob. Run every `chkit` command from the chkit root, or pass `--config <path>`. If the Tinybird project is built with `tb --max-depth <n>`, set `maxDepth: <n>`.

## Phase 4: Preview, and prune if asked

1. Run `chkit plugin tinybird import --dryrun --json`. It reads local files only and writes nothing.
2. Summarise for the user: counts per kind (`datasource`, `materialized`, `copy`, `endpoint`) and status (`translated`, `untranslatable`, `skipped`), the not-translated objects grouped by reason, and the translated objects that carry `warnings` (Kafka datasources: see Phase 6). Skipped files are ones `tb build` itself ignores (too deep, `vendor*`, hidden, unreadable) or sinks and connection files; mention them only if there are many or they look intentional.
3. If the user chose to prune, find what is used. Tinybird keeps per-request endpoint stats in `tinybird.pipe_stats_rt` (about 7 days):

   ```sql
   SELECT pipe_name, count() AS requests, countIf(status_code = 200) AS ok, max(start_datetime) AS last_call
   FROM tinybird.pipe_stats_rt
   WHERE start_datetime >= now() - INTERVAL 7 DAY
   GROUP BY pipe_name ORDER BY requests DESC
   ```

   Ask the user to run it in the Tinybird UI (Playgrounds) and paste or export the result; organisations on the free plan can hit a daily request limit and get HTTP 429, so it may have to wait a day. Seven days miss monthly jobs: ask the user before treating an endpoint as dead. Then work out which datasources, materialized and copy pipes the used endpoints depend on, transitively, and import a copy of the project folder with only those datafiles. Never delete anything in Tinybird.

## Phase 5: Import

1. Run `chkit plugin tinybird import` (add `--force` only when replacing files from an earlier import, after telling the user).
2. Read the head of the schema file: it lists every not-translated object with its reasons, and the translated objects with something to set up. Check the report file for `copyFallbacks`.
3. Run `chkit generate --dryrun` to confirm chkit sees the new tables and views. If it reports zero operations, the schema glob does not match `outFile` (Phase 3).

## Phase 6: What did not translate

Handle each group with the user. Write replacements in your own files (`tinybird-manual.ts`), never in the generated ones, and say for each whether it keeps exact Tinybird behaviour. Start by dropping, with the user's agreement, the endpoints no caller uses (Phase 3 or Phase 4).

**Endpoints with `{% if %}`, `defined()`, `elif`/`else`.** Tinybird renders the template per request and sends only the chosen branch to ClickHouse. Give the caller one chkit query per branch it uses, and let the application pick the query:

1. Ask which parameter combinations the callers actually send (look in the application code for the calls when it is in the repository). An endpoint with several independent optional filters has one branch per combination (6 filters: up to 64); write only the ones in use.
2. Do not retype the SQL. Make a scratch copy of the whole Tinybird project; in it, for each branch, write a copy of the endpoint with the `{% %}` statements resolved for that combination: keep the chosen branch's lines, drop the others and the tags, change nothing else. Run the import on the copy with a temporary config whose outputs go to the scratch folder, and take each generated query into `tinybird-manual.ts` under a name that says its branch. The plugin then renders each branch exactly as it renders any endpoint.
3. When a branch depends on the request's value (for example `tf` choosing a table), the query still takes that param if its SQL uses it.
4. When the user wants proof, ask them to open `/v0/pipes/<pipe>/explain?<params>` for each branch's params on their workspace and paste the SQL, and compare it with yours.
5. Folding branches into one query with `if()`/`multiIf()` or `isNull(param) OR …` changes the SQL Tinybird runs; offer it only for combinations too many to list, and say that it changes the SQL.

**Other not-translated objects:**

| Reason in the report | What to do |
|---|---|
| Endpoint with `Array()`, `column()` or `Boolean()` | Write the query by hand: `column(x)` maps to `p.identifier`, arrays to an `Array(T)` param, starting from the plugin's output for the rest of the SQL as above. |
| A param with different defaults at different sites | Tinybird applies each site's default. Ask which default the callers rely on (search their calls for the param); give the chkit query that default, after telling the user which callers that changes. |
| Copy pipe with `@on-demand` or a cron ClickHouse cannot match | The report's `copyFallbacks` hold the exact SELECT and target. Run `INSERT INTO <target> <select>` from a scheduler the user picks (cron, CI, an orchestrator), or, only if the user accepts the different timing, a refreshable materialized view on a nearby `REFRESH EVERY` schedule. |
| `ENGINE_SAMPLING_KEY` | The chkit table DSL has no `SAMPLE BY`. Ask whether sampling is used; if not, drop it and import a copy without it. Otherwise keep the table out of chkit and manage it with raw SQL. |
| `INCLUDE` or `$VAR` / `${VAR}` substitution | Tinybird resolves these at build time. Make a copy of the project with includes inlined and variables replaced by the values the user gives, and import the copy. |
| Reads `tinybird.*` service datasources or other workspaces | No equivalent in plain ClickHouse. Rewrite against `system.*` tables or the other workspace's imported tables, or drop it. |

**Ingestion, tokens and sinks** are never translated. List the ones the project uses (`.connection` files, `KAFKA_*`/`IMPORT_*` lines, `TYPE sink`, `TOKEN` lines) and tell the user what replaces each: a ClickHouse `Kafka` engine table plus a materialized view, an `S3Queue` table plus a materialized view, `@chkit/plugin-ingest` for API sources, their own inserts, and their own auth for tokens. Datasources fed by the Events API (they declare `json:$…` JSONPaths) get their tables, but nothing writes to them until the user sets up ingestion.

**Kafka datasources** are translated with the columns Tinybird adds to them (`__value`, `__topic`, `__partition`, `__offset`, `__timestamp`, `__key`, and `__headers` when `KAFKA_STORE_HEADERS` is on), so the table matches Tinybird and downstream objects that read those columns keep working. Their report entry carries a warning: ingestion is not translated, and something must consume the topic. Tell the user, and agree who fills the table.

## Phase 7: Apply

1. **Generate.** Once the database name is chosen, `chkit generate --name import_tinybird` works offline, with no target yet. Do it, review the SQL with the user, and leave applying for when the target exists.
2. **Load the connection.** `chkit` runs under Node, so `bunx chkit` and `npx chkit` do not read `.env` by themselves. From the chkit root use `node --env-file=.env ./node_modules/chkit/dist/bin/chkit.js <command>`, as the `chkit` skill describes.
3. **Confirm the target** with the user (URL, user, database) before applying. While the target database does not exist yet, a connected `chkit` command against it fails; check the server with the database overridden, for example `CLICKHOUSE_DB=default node --env-file=.env ./node_modules/chkit/dist/bin/chkit.js query "SELECT version(), timezone()"` (variables already set win over `--env-file`). Never print the password.
4. **Apply** with `chkit migrate --apply`, only with the user's authorization.
5. **Check the result**: `chkit status` (nothing pending), `chkit drift` and `chkit check`, and run each translated and hand-written query once with sample params. Known false positive: chkit up to 0.2.0-beta.16 reports `query_mismatch` for a materialized view whose query writes a function name in upper case (`FLOOR(…)` stored as `floor(…)`), and `chkit check` then fails on `schema_drift` (https://github.com/obsessiondb/chkit/issues/729). Tell the user when that is the only difference; do not edit the generated file.
6. Warn about two behaviours: refreshable materialized views run on the server's timezone while Tinybird schedules in UTC (run the server in UTC or adjust offsets), and they start `EMPTY`, as Tinybird does not copy on deploy.
7. The import moves no data. Moving data is a separate task: export from Tinybird or re-ingest from the source, then backfill materialized views (`@chkit/plugin-backfill`).
8. Translated endpoints are functions in `queriesOutFile`. If an application called the Tinybird URLs, it needs an HTTP layer that validates input with `<query>.params`, picks the branch query where Phase 6 split one, calls it and enforces auth. Never ship ClickHouse credentials to a browser.

## Report

End with: the project and database imported; counts translated, not translated and skipped; each not-translated object and what was done or is pending; files written; whether migrations were generated or applied and what the checks said; and what remains (data, ingestion, endpoints' HTTP layer, tokens).
