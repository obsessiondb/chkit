# @chkit/plugin-obsessiondb

## 0.2.0-beta.10

### Patch Changes

- Updated dependencies [3c546e8]
  - @chkit/clickhouse@0.2.0-beta.10
  - @chkit/plugin-backfill@0.2.0-beta.10
  - @chkit/core@0.2.0-beta.10

## 0.2.0-beta.9

### Patch Changes

- 2f53550: Support `MATERIALIZED`, `ALIAS`, and `EPHEMERAL` columns with a new `defaultKind` column field. `default` holds the value or `fn:` expression for every kind, and `EPHEMERAL` may omit it. SQL rendering, `pull`, snapshots, and drift keep the kind; validation reports `column_expression_required` and `column_default_kind_invalid`.

  - `DEFAULT`/`MATERIALIZED` expression changes emit `MODIFY COLUMN` with a warning that stored values are not rewritten, and removed expressions emit `REMOVE DEFAULT`/`REMOVE MATERIALIZED`. Conversions to or from `ALIAS`/`EPHEMERAL` fail `generate` with `column_kind_change_unsupported`.
  - Codegen emits `Row` (`SELECT *`), `RowExplicit` (all readable columns), and `RowInsert` (all insertable columns) for these tables; ingest helpers take `RowInsert`.
  - Inserts into tables with `EPHEMERAL` columns name their columns: generated ingest helpers pass `columns`, which `@chkit/clickhouse` `insert()` and the ObsessionDB remote executor send, and the `@chkit/plugin-ingest` destination does the same.
  - Automatic backfills omit `MATERIALIZED` and `ALIAS` columns and check live column kinds first: a copy is blocked only when the target has both `EPHEMERAL` and `MATERIALIZED` columns, `mv_replay` by any `EPHEMERAL` column, and a missing target fails with "does not exist or is not visible yet".
  - `drift` and `check` compare defaults token by token. Write expressions in the canonical form ClickHouse stores, such as `CAST(x, 'String')`, to avoid drift.
  - Fix string defaults containing backslashes: `C:\temp` now renders as `DEFAULT 'C:\\temp'`.

- 96a18c6: Recover a migration that failed part-way without editing the journal table by hand (#233). When no statement of the in-progress migration had completed or was interrupted while running, an edited file now runs again from statement 1 on the next `chkit migrate --apply`. Otherwise `chkit migrate --apply --retry <migration>` resumes with the edited file: chkit checks that every statement that completed keeps its position and `-- operation:` marker, and that statements sharing such a marker (a column's `REMOVE DEFAULT` or `REMOVE MATERIALIZED` and the `MODIFY COLUMN` after it) all stay in the file, records the new checksum, and continues from the first statement that did not complete. For any other migration `--retry` has no effect and the output says so, also when nothing is pending, so pipelines can pass it to every environment. `chkit migrate --abandon <migration>` shows what it would reset and, with `--apply`, writes a new journal version in which every recorded statement failed, so the next apply runs the file from statement 1; it lists the statements that stay applied in ClickHouse, runs no migration SQL (its only write is a journal INSERT), and needs neither the migration file nor a readable `snapshot.json`. The refusal for an edited in-progress migration names both commands, and these errors carry stable `--json` error codes. An async statement now only trusts `system.query_log` entries of queries that started after it was submitted, so a load that an earlier attempt finished is no longer reported as finished when the edited statement fails before it starts; such a failure is recorded as failed. A re-run that attaches to a still-running attempt likewise only trusts entries of queries that started no earlier than that attempt, so it no longer records an earlier attempt's result for it. The ObsessionDB remote executor now compares these bounds with the query's start time, as a direct connection does: its status checks failed with `TYPE_MISMATCH` on such a bound, so a retried async statement was never journaled as completed and each re-run loaded its data again. It also reports how long a running query has run, which an attach needs for its bound. In `--json` mode, async progress lines go to stderr instead of stdout. `chkit migrate --apply` refuses to apply a pending migration file without executable statements, such as a `generate --empty` stub without SQL, instead of recording it as applied; plan mode lists these files. In `@chkit/core`, `extractExecutableStatements` no longer returns a statement made only of comments, which ClickHouse rejects as `Empty query` (for example a block comment after the last statement).
- b59fc83: The ObsessionDB remote executor now sends per-insert `settings` (such as `insert_deduplication_token`) with `insert`. Before, it silently dropped them, so an insert retried through it was not deduplicated.
- cfabb19: Fix `--force-shared-engines` and `--no-shared-engines`. The plugin looked the parsed flags up without their `--` prefix, so both overrides were silently ignored and host auto-detection always decided whether the `storage_policy` table setting was stripped. `--force-shared-engines` now keeps it for a URL not recognized as ObsessionDB (for example a service behind a custom domain), and `--no-shared-engines` strips it even when targeting ObsessionDB. The flags take effect in `chkit generate` and `chkit snapshot rebuild`, which now accepts them too, so a rebuilt snapshot matches what `generate` writes; `migrate`, `status`, `drift` and `check` still accept them but ignore them. The flag help no longer claims to keep `Shared` engines, and the docs now state that chkit writes the standard engine name (`SharedMergeTree` becomes `MergeTree()`) for every target while the plugin only strips `storage_policy`.
- Updated dependencies [d072fe3]
- Updated dependencies [2f53550]
- Updated dependencies [98e3667]
- Updated dependencies [96a18c6]
- Updated dependencies [46cbf88]
- Updated dependencies [46cbf88]
- Updated dependencies [b59fc83]
- Updated dependencies [c49f0a9]
- Updated dependencies [672d67e]
  - @chkit/core@0.2.0-beta.9
  - @chkit/clickhouse@0.2.0-beta.9
  - @chkit/plugin-backfill@0.2.0-beta.9

## 0.2.0-beta.8

### Patch Changes

- 3f9a246: Fix `backfill` mv_replay so it rebuilds **every** materialized view feeding the target table, not just the first. ClickHouse allows several MVs to share one destination table; previously only the first-declared MV was replayed and the rest were silently dropped, leaving the backfill incomplete. Each chunk now runs one `INSERT INTO target … SELECT … UNION ALL SELECT …` covering all matching MVs, so a single query id and idempotency token still cover the chunk. Single-MV plans are unchanged.
- 4ded781: Print the "Next steps" block once and with the correct runner for the selected package manager. `create-chkit` previously printed it twice — once package-manager-aware and once from onboarding with a hardcoded `bunx` — so `--package-manager npm` users were told to run `bunx chkit …`. Onboarding now derives the runner (`npx` / `pnpm dlx` / `yarn dlx` / `bunx`) from the package manager, and `create-chkit` only prints its own next-steps when onboarding is skipped, removing the duplicate.
- 75d15e9: Stop `chkit drift` from reporting `index_mismatch` for skip indexes it just created. Introspection read `system.data_skipping_indices.type`, which holds only the index name (`ngrambf_v1`), so every argument parsed as 0; it now reads `type_full` (`ngrambf_v1(3, 4096, 2, 0)`). chkit renders `INDEX name (expr)` and ClickHouse keeps those parentheses in `expr`, so the comparison now drops one pair when it encloses the whole expression. chkit-py introspection reads `type_full` as well.
- 4ded781: Make `--json` always emit a JSON object, never a bare JSON-encoded string. `printOutput` now wraps any plain string printed under `--json` in `{ schemaVersion, message }`, closing the whole class of bug at the serializer so no command can leak a bare string. `chkit obsessiondb whoami` gains a structured envelope (`status: logged_in | not_logged_in | session_expired`), and `chkit obsessiondb service list` emits a single object with a `services[]` array instead of one JSON line per service (which was not valid single-JSON). Previously these commands `JSON.stringify`'d a prose string (e.g. `"Not logged in…"`), breaking any pipe to `jq`. Text-mode output is unchanged. Note: this changes the `--json` output shape of `whoami` and `service list` from a string to an object.
- 4ded781: `chkit obsessiondb logout` now reports "No active session." when there are no stored credentials, instead of always printing "Logged out." (which implied it had ended a session that never existed). Logout stays idempotent and exits 0 either way; only the message changes.
- 3cc768d: Pin `@orpc/client` and `@orpc/contract` to 1.15.4 to fix prototype pollution (CVE-2026-28794) and include the subsequent deserializer validation fix (GHSA-4p2c-m292-ghmh). Keep exact versions and align the oRPC dependency family.
- Updated dependencies [f85f568]
- Updated dependencies [3f9a246]
- Updated dependencies [9ad23f9]
- Updated dependencies [65c90d6]
- Updated dependencies [75d15e9]
- Updated dependencies [3f1db03]
- Updated dependencies [f8238db]
- Updated dependencies [fedbf56]
- Updated dependencies [5a8d805]
- Updated dependencies [8296b8a]
- Updated dependencies [b501f5d]
- Updated dependencies [256ec62]
  - @chkit/plugin-backfill@0.2.0-beta.8
  - @chkit/core@0.2.0-beta.8
  - @chkit/clickhouse@0.2.0-beta.8

## 0.1.2-beta.7

### Patch Changes

- 3f9a246: Fix `backfill` mv_replay so it rebuilds **every** materialized view feeding the target table, not just the first. ClickHouse allows several MVs to share one destination table; previously only the first-declared MV was replayed and the rest were silently dropped, leaving the backfill incomplete. Each chunk now runs one `INSERT INTO target … SELECT … UNION ALL SELECT …` covering all matching MVs, so a single query id and idempotency token still cover the chunk. Single-MV plans are unchanged.
- Updated dependencies [f85f568]
- Updated dependencies [3f9a246]
- Updated dependencies [9ad23f9]
- Updated dependencies [65c90d6]
- Updated dependencies [3f1db03]
- Updated dependencies [5a8d805]
- Updated dependencies [8296b8a]
- Updated dependencies [b501f5d]
  - @chkit/plugin-backfill@0.1.2-beta.7
  - @chkit/core@0.1.2-beta.7
  - @chkit/clickhouse@0.1.2-beta.7

## 0.1.2-beta.6

### Patch Changes

- 3f9a246: Fix `backfill` mv_replay so it rebuilds **every** materialized view feeding the target table, not just the first. ClickHouse allows several MVs to share one destination table; previously only the first-declared MV was replayed and the rest were silently dropped, leaving the backfill incomplete. Each chunk now runs one `INSERT INTO target … SELECT … UNION ALL SELECT …` covering all matching MVs, so a single query id and idempotency token still cover the chunk. Single-MV plans are unchanged.
- Updated dependencies [f85f568]
- Updated dependencies [3f9a246]
- Updated dependencies [9ad23f9]
- Updated dependencies [65c90d6]
- Updated dependencies [3f1db03]
- Updated dependencies [5a8d805]
- Updated dependencies [8296b8a]
- Updated dependencies [b501f5d]
  - @chkit/plugin-backfill@0.1.2-beta.6
  - @chkit/core@0.1.2-beta.6
  - @chkit/clickhouse@0.1.2-beta.6

## 0.1.2-beta.5

### Patch Changes

- 3f9a246: Fix `backfill` mv_replay so it rebuilds **every** materialized view feeding the target table, not just the first. ClickHouse allows several MVs to share one destination table; previously only the first-declared MV was replayed and the rest were silently dropped, leaving the backfill incomplete. Each chunk now runs one `INSERT INTO target … SELECT … UNION ALL SELECT …` covering all matching MVs, so a single query id and idempotency token still cover the chunk. Single-MV plans are unchanged.
- Updated dependencies [f85f568]
- Updated dependencies [3f9a246]
- Updated dependencies [9ad23f9]
- Updated dependencies [3f1db03]
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/plugin-backfill@0.1.2-beta.5
  - @chkit/clickhouse@0.1.2-beta.5
  - @chkit/core@0.1.2-beta.5

## 0.1.2-beta.4

### Patch Changes

- 3f9a246: Fix `backfill` mv_replay so it rebuilds **every** materialized view feeding the target table, not just the first. ClickHouse allows several MVs to share one destination table; previously only the first-declared MV was replayed and the rest were silently dropped, leaving the backfill incomplete. Each chunk now runs one `INSERT INTO target … SELECT … UNION ALL SELECT …` covering all matching MVs, so a single query id and idempotency token still cover the chunk. Single-MV plans are unchanged.
- Updated dependencies [f85f568]
- Updated dependencies [3f9a246]
- Updated dependencies [9ad23f9]
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/plugin-backfill@0.1.2-beta.4
  - @chkit/core@0.1.2-beta.4
  - @chkit/clickhouse@0.1.2-beta.4

## 0.1.2-beta.3

### Patch Changes

- 3f9a246: Fix `backfill` mv_replay so it rebuilds **every** materialized view feeding the target table, not just the first. ClickHouse allows several MVs to share one destination table; previously only the first-declared MV was replayed and the rest were silently dropped, leaving the backfill incomplete. Each chunk now runs one `INSERT INTO target … SELECT … UNION ALL SELECT …` covering all matching MVs, so a single query id and idempotency token still cover the chunk. Single-MV plans are unchanged.
- Updated dependencies [f85f568]
- Updated dependencies [3f9a246]
- Updated dependencies [9ad23f9]
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/plugin-backfill@0.1.2-beta.3
  - @chkit/core@0.1.2-beta.3
  - @chkit/clickhouse@0.1.2-beta.3

## 0.1.2-beta.2

### Patch Changes

- 3f9a246: Fix `backfill` mv_replay so it rebuilds **every** materialized view feeding the target table, not just the first. ClickHouse allows several MVs to share one destination table; previously only the first-declared MV was replayed and the rest were silently dropped, leaving the backfill incomplete. Each chunk now runs one `INSERT INTO target … SELECT … UNION ALL SELECT …` covering all matching MVs, so a single query id and idempotency token still cover the chunk. Single-MV plans are unchanged.
- Updated dependencies [3f9a246]
- Updated dependencies [9ad23f9]
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/plugin-backfill@0.1.2-beta.2
  - @chkit/core@0.1.2-beta.2
  - @chkit/clickhouse@0.1.2-beta.2

## 0.1.2-beta.1

### Patch Changes

- Updated dependencies [9ad23f9]
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/plugin-backfill@0.1.2-beta.1
  - @chkit/core@0.1.2-beta.1
  - @chkit/clickhouse@0.1.2-beta.1

## 0.1.2-beta.0

### Patch Changes

- Updated dependencies [9ad23f9]
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/plugin-backfill@0.1.2-beta.0
  - @chkit/core@0.1.2-beta.0
  - @chkit/clickhouse@0.1.2-beta.0

## 0.1.1

### Patch Changes

- c1d8d0d: Add `chkit backfill submit` to run a backfill as a managed ObsessionDB job. It builds the plan with the same chunking algorithm as the local `run`, submits the chunks to the ObsessionDB job backend, and prints a console link to track progress instead of polling locally — the heavier, MV-replay-aware path lives in the ObsessionDB plugin. The plugin's remote executor now forwards ClickHouse query settings (e.g. `enable_parallel_replicas`) so remote plan sizing matches the local planner.
- Updated dependencies [6b87e6d]
- Updated dependencies [c1d8d0d]
  - @chkit/core@0.1.1
  - @chkit/plugin-backfill@0.1.1
  - @chkit/clickhouse@0.1.1

## 0.1.0

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- bb62cd0: Backfill `plan`/`run`/`resume` now refuse to run against ObsessionDB instead of silently opening a direct ClickHouse connection. When a service is selected, these commands will eventually submit jobs to the ObsessionDB backend; until that lands they error with a clear message pointing to `--local` for direct execution.
- bb62cd0: Print the "Next steps" block once and with the correct runner for the selected package manager. `create-chkit` previously printed it twice — once package-manager-aware and once from onboarding with a hardcoded `bunx` — so `--package-manager npm` users were told to run `bunx chkit …`. Onboarding now derives the runner (`npx` / `pnpm dlx` / `yarn dlx` / `bunx`) from the package manager, and `create-chkit` only prints its own next-steps when onboarding is skipped, removing the duplicate.
- d9d5038: Polish error messages and a few noisy outputs:

  - A table defined with `orderBy` but no `primaryKey` no longer crashes with a raw `TypeError`; the primary key defaults to the order-by columns, matching ClickHouse.
  - Built-in command errors (e.g. a rejected migration) surface their own clean message instead of being wrapped in `Plugin "core" failed in ...`.
  - `chkit query` syntax errors no longer leak the injected `FORMAT JSON` clause the user never typed, and the "Expected one of" token dump is capped.
  - Connection errors whose reason is only in the message (no `.code`) — e.g. a typo'd host — are now recognized and cleaned instead of leaking the raw client string.
  - The post-apply message names the resolved journal table (respecting `CHKIT_JOURNAL_TABLE`) instead of a hardcoded `_chkit_migrations`.
  - The ObsessionDB "authenticated but no service selected" reminder is suppressed when a direct `clickhouse` target is configured (it was layered in from a global login, not chosen for the project).

- ca968d9: Fix stale internal dependency pins in published packages. `chkit` shipped with `@chkit/plugin-obsessiondb` pinned one version behind because the publish step only resolved `workspace:` specifiers in `dependencies`/`devDependencies`, skipping `optionalDependencies` (where the plugin is declared) — so the CLI bundled an outdated plugin and every `chkit query` failed with `serviceSlug is required`.

  The publish resolver now covers every dependency field, `@chkit/codegen` uses `workspace:*` for `@chkit/core` instead of an exact pin, and two release guards (source-side `check:workspace-deps` and packed-tarball `check:packed-deps`) fail the build if any publishable package would ship a stale or unresolved internal dependency.

- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- bb62cd0: Register the `--local` and `--service` overrides against the correct command keys. The command registry keys plugin flag extensions by top-level command name, so the previous two-word targets (e.g. `backfill run`) never matched — `chkit backfill plan/run/resume --local` was rejected as an unknown flag, making the local-execution escape hatch unreachable. `--service` was also never extended to `pull`, so `chkit pull schema --service <name>` failed. Both flags now parse and route correctly.
- 0016a11: Emit a structured `--json` envelope from the non-interactive ObsessionDB auth flow so programmatic callers can chain steps without parsing prose. `signup` and `service claim` now honor `--json`: each terminal/pause state prints a single `{ command, schemaVersion, status, next }` object instead of human runbook text, where `next` carries the exact command to run (e.g. `{ "status": "otp_sent", "email": "me@x.com", "next": { "needs": "code", "command": "chkit obsessiondb signup --email me@x.com --code <CODE>" } }`). Statuses cover `no_email → otp_sent → verified` (signup) and `claimed` / `provisioning` / `already_claimed` (claim); failures emit the `ok:false` error envelope. Text-mode output is unchanged, and the runbook command strings are now the single source shared by both prose and JSON so they cannot drift.
- bb62cd0: Make `--json` always emit a JSON object, never a bare JSON-encoded string. `printOutput` now wraps any plain string printed under `--json` in `{ schemaVersion, message }`, closing the whole class of bug at the serializer so no command can leak a bare string. `chkit obsessiondb whoami` gains a structured envelope (`status: logged_in | not_logged_in | session_expired`), and `chkit obsessiondb service list` emits a single object with a `services[]` array instead of one JSON line per service (which was not valid single-JSON). Previously these commands `JSON.stringify`'d a prose string (e.g. `"Not logged in…"`), breaking any pipe to `jq`. Text-mode output is unchanged. Note: this changes the `--json` output shape of `whoami` and `service list` from a string to an object.
- bb62cd0: `chkit obsessiondb logout` now reports "No active session." when there are no stored credentials, instead of always printing "Logged out." (which implied it had ended a session that never existed). Logout stays idempotent and exits 0 either way; only the message changes.
- 99136de: Add ObsessionDB onboarding to `chkit init` and `create-chkit`: a 3-way "how do you want to connect?" prompt covering an existing ClickHouse instance, an existing ObsessionDB account, and claiming a free ObsessionDB dev instance. Adds passwordless CLI signup (`chkit obsessiondb signup`, email + one-time code) with automatic personal-org creation, and `chkit obsessiondb service claim` to claim and provision a free instance, then write a ready-to-use connection.

  Non-interactive callers (agents/CI) now get a full runbook instead of dead-end prompts: when no TTY is detected, onboarding prints every connect path as runnable commands, and `signup` supports a two-step OTP flow — `--request-only` sends the code and prints the exact follow-up command, then `--email --code <CODE>` verifies without re-sending (which would otherwise invalidate the code). When an explicit connect path is requested but cannot complete (e.g. `--connect claim` with no email, or a bad code), `chkit init` and `create-chkit` now exit non-zero instead of falling through to "next steps" with a success status, so scripts can detect the failure.

- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- 75bf348: Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

  Notes:

  - The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
  - The remote backfill flag `--service-id` is renamed to `--service-slug`.

- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- bb62cd0: Send a versioned `User-Agent: chkit/<version>` to the ObsessionDB API (oRPC query client and auth client) instead of a flat `chkit-cli`. This matches the direct-ClickHouse executor's identity and lets the API forward the header so CLI traffic is attributable in `system.query_log.http_user_agent`.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 713176e: Sanitize the auto-derived default org name during ObsessionDB signup. The personal org name is now stripped of the email `+subaddress` (e.g. `marc+clisignup@…` → `marc`) and any non-display characters, falling back to `playground` when nothing usable remains. The `--org-name` override still wins.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- dfaa8fa: Consolidate all publishable packages on Zod 4. `@chkit/plugin-obsessiondb` was pinned to `zod@3.25.76` while the rest of the toolkit used Zod 4, pulling two major versions into the dependency tree; it now uses `zod@^4.3.6`. Its oRPC contracts are unaffected — `@orpc/contract` validates through the Standard Schema interface, which both Zod majors implement. `@chkit/plugin-codegen` now declares `zod` as a peer dependency (`^4.0.0`) instead of a direct dependency, so generated Zod schemas resolve against the consumer's own `zod` install rather than a bundled copy.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [f4e5a59]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [95e6dbb]
- Updated dependencies [ff1cd31]
- Updated dependencies [d9d5038]
- Updated dependencies [a94a2a1]
- Updated dependencies [17b8a27]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [8d5878a]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [5ee4afc]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [72c3fdd]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [0aa2c28]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0
  - @chkit/clickhouse@0.1.0

## 0.1.0-beta.29

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- d9d5038: Polish error messages and a few noisy outputs:

  - A table defined with `orderBy` but no `primaryKey` no longer crashes with a raw `TypeError`; the primary key defaults to the order-by columns, matching ClickHouse.
  - Built-in command errors (e.g. a rejected migration) surface their own clean message instead of being wrapped in `Plugin "core" failed in ...`.
  - `chkit query` syntax errors no longer leak the injected `FORMAT JSON` clause the user never typed, and the "Expected one of" token dump is capped.
  - Connection errors whose reason is only in the message (no `.code`) — e.g. a typo'd host — are now recognized and cleaned instead of leaking the raw client string.
  - The post-apply message names the resolved journal table (respecting `CHKIT_JOURNAL_TABLE`) instead of a hardcoded `_chkit_migrations`.
  - The ObsessionDB "authenticated but no service selected" reminder is suppressed when a direct `clickhouse` target is configured (it was layered in from a global login, not chosen for the project).

- ca968d9: Fix stale internal dependency pins in published packages. `chkit` shipped with `@chkit/plugin-obsessiondb` pinned one version behind because the publish step only resolved `workspace:` specifiers in `dependencies`/`devDependencies`, skipping `optionalDependencies` (where the plugin is declared) — so the CLI bundled an outdated plugin and every `chkit query` failed with `serviceSlug is required`.

  The publish resolver now covers every dependency field, `@chkit/codegen` uses `workspace:*` for `@chkit/core` instead of an exact pin, and two release guards (source-side `check:workspace-deps` and packed-tarball `check:packed-deps`) fail the build if any publishable package would ship a stale or unresolved internal dependency.

- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- 99136de: Add ObsessionDB onboarding to `chkit init` and `create-chkit`: a 3-way "how do you want to connect?" prompt covering an existing ClickHouse instance, an existing ObsessionDB account, and claiming a free ObsessionDB dev instance. Adds passwordless CLI signup (`chkit obsessiondb signup`, email + one-time code) with automatic personal-org creation, and `chkit obsessiondb service claim` to claim and provision a free instance, then write a ready-to-use connection.

  Non-interactive callers (agents/CI) now get a full runbook instead of dead-end prompts: when no TTY is detected, onboarding prints every connect path as runnable commands, and `signup` supports a two-step OTP flow — `--request-only` sends the code and prints the exact follow-up command, then `--email --code <CODE>` verifies without re-sending (which would otherwise invalidate the code). When an explicit connect path is requested but cannot complete (e.g. `--connect claim` with no email, or a bad code), `chkit init` and `create-chkit` now exit non-zero instead of falling through to "next steps" with a success status, so scripts can detect the failure.

- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- 75bf348: Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

  Notes:

  - The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
  - The remote backfill flag `--service-id` is renamed to `--service-slug`.

- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- dfaa8fa: Consolidate all publishable packages on Zod 4. `@chkit/plugin-obsessiondb` was pinned to `zod@3.25.76` while the rest of the toolkit used Zod 4, pulling two major versions into the dependency tree; it now uses `zod@^4.3.6`. Its oRPC contracts are unaffected — `@orpc/contract` validates through the Standard Schema interface, which both Zod majors implement. `@chkit/plugin-codegen` now declares `zod` as a peer dependency (`^4.0.0`) instead of a direct dependency, so generated Zod schemas resolve against the consumer's own `zod` install rather than a bundled copy.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [f4e5a59]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [95e6dbb]
- Updated dependencies [ff1cd31]
- Updated dependencies [d9d5038]
- Updated dependencies [a94a2a1]
- Updated dependencies [17b8a27]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [8d5878a]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [5ee4afc]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [72c3fdd]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [0aa2c28]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.29
  - @chkit/clickhouse@0.1.0-beta.29

## 0.1.0-beta.28

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- ca968d9: Fix stale internal dependency pins in published packages. `chkit` shipped with `@chkit/plugin-obsessiondb` pinned one version behind because the publish step only resolved `workspace:` specifiers in `dependencies`/`devDependencies`, skipping `optionalDependencies` (where the plugin is declared) — so the CLI bundled an outdated plugin and every `chkit query` failed with `serviceSlug is required`.

  The publish resolver now covers every dependency field, `@chkit/codegen` uses `workspace:*` for `@chkit/core` instead of an exact pin, and two release guards (source-side `check:workspace-deps` and packed-tarball `check:packed-deps`) fail the build if any publishable package would ship a stale or unresolved internal dependency.

- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- 75bf348: Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

  Notes:

  - The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
  - The remote backfill flag `--service-id` is renamed to `--service-slug`.

- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [95e6dbb]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.28
  - @chkit/clickhouse@0.1.0-beta.28

## 0.1.0-beta.27

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- 75bf348: Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

  Notes:

  - The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
  - The remote backfill flag `--service-id` is renamed to `--service-slug`.

- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [95e6dbb]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.27
  - @chkit/clickhouse@0.1.0-beta.27

## 0.1.0-beta.26

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.26
  - @chkit/clickhouse@0.1.0-beta.26

## 0.1.0-beta.25

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.25
  - @chkit/clickhouse@0.1.0-beta.25

## 0.1.0-beta.24

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.24
  - @chkit/clickhouse@0.1.0-beta.24

## 0.1.0-beta.23

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `select-service`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.23
  - @chkit/clickhouse@0.1.0-beta.23

## 0.1.0-beta.22

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.22
  - @chkit/clickhouse@0.1.0-beta.22

## 0.1.0-beta.21

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.21
  - @chkit/clickhouse@0.1.0-beta.21

## 0.1.0-beta.20

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.20

## 0.1.0-beta.19

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.19

## 0.1.0-beta.18

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.18

## 0.1.0-beta.17

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.17

## 0.1.0-beta.16

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.16

## 0.1.0-beta.15

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.15

## 0.1.0-beta.14

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.14

## 0.1.0-beta.13

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.13

## 0.1.0-beta.12

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.12

## 0.1.0-beta.11

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.11

## 0.1.0-beta.10

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.10

## 0.1.0-beta.9

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.9

## 0.1.0-beta.8

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.8
