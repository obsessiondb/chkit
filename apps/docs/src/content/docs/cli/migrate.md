---
title: "chkit migrate"
description: "Apply pending migration files to ClickHouse."
sidebar:
  order: 4
---

Applies pending migration SQL files to your ClickHouse instance. Supports plan-only mode, interactive confirmation, destructive operation safety, checksum verification, and recovery from failed migrations.

## Synopsis

```
chkit migrate [flags]
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--apply` | boolean | `false` | Apply pending migrations without prompting |
| `--execute` | boolean | `false` | Alias for `--apply` |
| `--allow-destructive` | boolean | `false` | Allow destructive operations (required in non-interactive mode) |
| `--retry <migration>` | string | — | Resume a [failed migration](#failed-migrations) after editing its file; completed statements are skipped. Takes effect with `--apply` or interactive confirmation |
| `--abandon <migration>` | string | — | Reset a failed migration so the next apply runs it from statement 1. Preview with `--json`; cannot be combined with `--retry`, `--table`, or `--allow-destructive` |
| `-t`, `--table <selector>` | string | — | Scope migrations to those affecting matching tables |
| `--break-lock <claim>` | string | — | Release the [migrate lock](#concurrent-runs) claim of a run that is no longer running, then take the lock |
| `--setting <name=value>` | string[] | — | Send a ClickHouse [query setting](#query-settings) with each migration statement. Repeatable, or comma-separated |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

### Plan vs execute

Use `chkit migrate --json` to preview pending migrations without applying them. After reviewing the plan and SQL, pass `--apply` (or `--execute`) to apply.

In interactive mode (TTY), a plain `chkit migrate` prints the plan and prompts for confirmation before applying. In non-interactive mode (CI, piped input), it only reports the plan unless `--apply` is present. JSON mode suppresses the interactive prompt, so `--json` without `--apply` always previews.

### CI / non-interactive detection

The CLI detects non-interactive contexts when any of these conditions are true:

- `CI=1` or `CI=true` environment variable is set
- stdin is not a TTY
- stdout is not a TTY

### Destructive operation safety

Migration files containing `risk=danger` operations (such as `DROP TABLE` or `DROP COLUMN`) require explicit approval:

- **Interactive mode**: the CLI prompts for confirmation
- **Non-interactive / CI mode**: `--allow-destructive` must be passed, or `safety.allowDestructive` must be `true` in config. Otherwise the command exits with code 3.
- **JSON mode**: exits with code 3 and includes details about blocked operations

Destructive statements are detected two ways. Planner-emitted migrations carry a `-- operation:` marker per statement, which sets the risk classification directly. In addition, chkit scans the executable SQL itself for hand-written destructive statements (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DROP VIEW` / `DROP MATERIALIZED VIEW`, `DETACH`, `DROP DATABASE`) that carry no marker — whether a whole migration was hand-written or a statement was appended to a generated one. Such statements previously applied silently in CI; they now require `--allow-destructive` (or `safety.allowDestructive`) like any other destructive operation. The scan reads SQL as ClickHouse does: a commented-out statement (`--`, `//`, `# `, `#!` or `/* */`) and text inside a string literal or quoted name are ignored, while a comment between keywords, as in `DROP /* old */ TABLE t`, does not hide a drop. Planner-marked non-danger statements keep their existing classification, so a generated materialized-view recreate is not blocked.

Each destructive operation includes a warning code, reason, impact description, and recommendation:

| Warning code | Operation |
|-------------|-----------|
| `drop_table_data_loss` | `DROP TABLE` |
| `table_recreate_data_loss` | `DROP TABLE` + `CREATE TABLE` recreate from a structural change (`engine` / `orderBy` / `primaryKey` / `partitionBy` / `uniqueKey`) — all rows lost, table recreated empty |
| `drop_column_irreversible` | `DROP COLUMN` |
| `drop_view_dependency_break` | `DROP VIEW` / `DROP MATERIALIZED VIEW` |
| `destructive_operation_review_required` | Other destructive operations |

### Query settings

`--setting <name=value>` sends a ClickHouse query setting with each statement of the migrations this run applies, through the HTTP request or, with an ObsessionDB service selected, the console API. It applies to this run only, and the migration files stay unchanged, so their checksums do too. The flag is optional and has no config equivalent: without it, chkit sends no settings.

The main use is a `DROP TABLE` that the server refuses because the table is larger than `max_table_size_to_drop` (50 GB by default). On a managed service there is no shell access to create the `force_drop_table` flag file, so lift the limit for the run:

```sh
chkit migrate --apply --allow-destructive --setting max_table_size_to_drop=0
```

A refused statement leaves the migration [in progress](#failed-migrations), so re-running with the setting resumes it at the `DROP`. Use `max_partition_size_to_drop=0` for a large `DROP PARTITION`.

The settings go with every statement a migration runs: synchronous statements, statements submitted with [`mode=async`](#async-operations-modeasync), the reads of a [`mode=barrier`](#insert-barriers-modebarrier) statement, and `-- before-retry:` SQL. chkit's own queries, such as journal reads and writes and the `system.*` polling of async statements, run without them.

`--setting` takes query settings only. It rejects the ClickHouse HTTP parameters `query`, `database`, `query_id`, `session_id`, `session_check`, `session_timeout`, `user` and `password` with a usage error before anything runs: they would change the database, credentials, query text or query ID that chkit tracks. Set the database and credentials in [`clickhouse`](/configuration/overview/) config instead.

### Server index granularity

Before it checks checksums or applies anything, `migrate` (except `--abandon`) fails when the server's MergeTree `index_granularity` default is not [`clickhouse.indexGranularity`](/configuration/overview/#mergetree-index-granularity-clickhouseindexgranularity) (8192 by default). The message names the value to set. When the server cannot be asked, the check is skipped.

### Checksum verification

Before applying, the CLI verifies SHA-256 checksums of all previously-applied migrations against the files on disk. If any file has been modified since it was applied, the command aborts with exit code 1.

### Failed migrations

chkit records the progress of each statement in the journal while a migration runs. When a statement fails, the migration stays **in progress**: the statements before it remain applied in ClickHouse, and the migration is not recorded as applied. Re-running `chkit migrate --apply` resumes it: completed statements are skipped and the failed statement runs again. That fixes a failure whose cause is outside the file, such as a missing table, a permission, or a transient error.

When the file itself is wrong, edit it. What the next `chkit migrate --apply` does depends on how far the migration got:

- **No statement is recorded as completed** (the first statement failed, or the migration was [abandoned](#abandoning-a-failed-migration), in which case the statements that ran stay applied and run again): the edited file runs again from statement 1, and the command prints `<file> changed since its last failed attempt; no statement is recorded as completed, so it runs again from statement 1.`
- **Some statements completed, or one was interrupted while it ran**: they ran from the old file, so `migrate` does not continue on its own:

```
Migration 20260929001110_funnel-model.sql has in-progress journal state for checksum 7808…, but the current file checksum is 3397…: the file changed after some of its statements had run.
  Resume with the edited file (completed statements are skipped): chkit migrate --apply --retry 20260929001110_funnel-model.sql
  Or discard the partial run, so the next apply starts the file over: chkit migrate --apply --abandon 20260929001110_funnel-model.sql
  Or restore the original file content and re-run chkit migrate --apply.
```

chkit reads `//`, `# ` and `#!` comments as ClickHouse does, up to the end of the line, so a `;`, quote or `/*` inside one does not end a statement or open a string. Releases before [#562](https://github.com/obsessiondb/chkit/issues/562) cut a statement at a `;` inside such a comment. When another chkit release applied part of a migration whose file has such a comment, and the statements it recorded as completed (or started) are not the same statements in the current split, `migrate` stops with the code `statement_split_changed` instead of resuming by position. Finish that migration with the release that recorded it, or [abandon](#abandoning-a-failed-migration) the partial run.

The journal also records a fingerprint of each statement it runs ([#599](https://github.com/obsessiondb/chkit/issues/599)). Before `migrate` resumes, it checks that each statement recorded as completed (or an async statement that may still be running) still has the same SQL at its position, comments and whitespace aside. When the file is unchanged but the statements differ, because a chkit release split the file differently or a plugin's `onBeforeApply` now returns other statements, `migrate` stops with `statement_split_changed` too. Statements recorded by a release before #599 have no fingerprint and are matched by position as before.

:::caution
Edit a failed migration only if no other environment that runs the same files has applied it, because checksum verification fails there. If the migration succeeded elsewhere, fix the cause in the failing environment and re-run `chkit migrate --apply` with the unchanged file.
:::

### Retrying a failed migration

```sh
chkit migrate --apply --retry 20260929001110_funnel-model.sql
```

`--retry` accepts the edited file for the named migration when every statement that completed still sits at the same position with the same `-- operation:` marker (operation type and key) and the same SQL. Comments and whitespace outside strings may change; any other change to a completed statement's SQL is refused, and so is any change to the inline data after `FORMAT <name>` in an `INSERT`. chkit then records the new checksum and continues from the first statement that did not complete, so a later failure resumes with a plain `chkit migrate --apply`. The name may be the file name with or without `.sql`, or a path to the file.

- Completed statements are skipped and never run again. Correct an applied statement with a new migration, not by editing it.
- Statements without an `-- operation:` marker are matched by position and SQL. Do not add, remove, or reorder statements above the one that failed.
- A statement that a chkit release before [#599](https://github.com/obsessiondb/chkit/issues/599) recorded has no fingerprint, so `--retry` checks only its position and marker.
- `--retry` warns about completed statements that have neither a marker nor a recorded fingerprint, which it can match by position only. In `--json` mode, `unmarkedCompletedStatements` counts the completed statements without a marker and `positionOnlyCompletedStatements` counts those of them without a recorded fingerprint.
- An [async statement](#async-operations-modeasync) that may still be running must also keep its position and marker. When an earlier attempt of it with other SQL is still running (for example after `--abandon` and an edit), `migrate` stops instead of attaching to that attempt: wait for it to finish or `KILL QUERY` it, then run `migrate` again.
- If a completed statement moved, or its marker or SQL changed, `--retry` refuses and lists the statements. Restore them, or [abandon](#abandoning-a-failed-migration) the partial run.
- Statements can share a marker: a column's generated `REMOVE DEFAULT` or `REMOVE MATERIALIZED` carries the marker of the `MODIFY COLUMN` after it. Keep both in the file and edit only the one that failed. `--retry` cannot tell them apart, so it also refuses an edit that leaves fewer statements with a completed statement's marker than the failed run recorded, such as one that deletes the completed `REMOVE`.
- The retry takes effect when `--apply` or interactive confirmation applies migrations. Add `--json` without `--apply` to preview where the migration will resume.
- When the named migration has no in-progress state, did not change since it failed, is already applied, has no executable statements, or is outside the `--table` scope, `--retry` has no effect and the output says so, also when nothing is pending, so the same command can run against every environment. A name that matches no migration file is an error.

### Abandoning a failed migration

```sh
chkit migrate --abandon 20260929001110_funnel-model.sql --json   # preview
chkit migrate --abandon 20260929001110_funnel-model.sql --apply  # reset
```

Resets the journal state of a failed migration so the next `chkit migrate --apply` runs it from statement 1. Use `--json` without `--apply` to report what it would reset. Without either flag, an interactive terminal asks for confirmation to reset the journal; a non-interactive run only reports the plan. It runs no migration SQL and applies no migration. It reads neither the migration file nor `snapshot.json`, so it works after the file was deleted or while `snapshot.json` has merge conflicts. It cannot be combined with `--retry`, `--table`, or `--allow-destructive`.

The report lists the statements that completed. They **stay applied** in ClickHouse, and the next apply runs them again with the rest of the file:

- Each statement must be safe to run twice. Generated `CREATE` and `DROP` statements use `IF NOT EXISTS` / `IF EXISTS`, but a table recreate drops the table again, with any rows written since, a data load such as `INSERT ... SELECT` adds its rows again, and a column's `REMOVE DEFAULT` or `REMOVE MATERIALIZED` fails, because the column no longer has that expression. Remove such statements from the file. When the `MODIFY COLUMN` after a completed `REMOVE` failed, [`--retry`](#retrying-a-failed-migration) skips the `REMOVE` instead. The destructive-operation check asks again for destructive statements.
- A data load can undo its earlier run with a `-- before-retry:` line instead. The line runs only when the statement keeps its position and its `-- operation:` type and key, so adding a marker to a load after the abandon does not help.
- An async statement that was interrupted may still be running on the server. The report prints its `query_id`; wait for the query to finish or run `KILL QUERY WHERE query_id = '…'` before you apply the migration again.

To regenerate the migration instead, delete the file, restore `chkit/meta/snapshot.json` from git to its state before the migration was generated, and run `chkit generate`. The statements that completed stay applied. The new migration runs the ones it repeats again, so they must be safe to run twice, as above: delete a repeated `REMOVE DEFAULT` or `REMOVE MATERIALIZED` from it before you apply it. Run `chkit drift` after you apply the new migration: a completed statement that the new migration does not repeat, such as a `DROP VIEW`, leaves the database out of step with the schema.

`--abandon` fails when the journal has no in-progress state for the migration, or when the migration is already applied.

### Empty migrations

`chkit migrate --apply` refuses to apply a pending migration file without executable statements, such as a [`chkit generate --empty`](/cli/generate/#empty-mode) stub that still waits for its SQL, or a file that holds only comments. Recording such a file as applied would make any SQL added to it later fail checksum verification. The command applies nothing, lists the files, and exits with code 1; add SQL to each file or delete it. In an interactive terminal, `chkit migrate` without `--apply` prints the plan and then refuses the same way, before its confirmation prompt. A plan-only run (in CI, or with `--json` and no `--apply`) marks empty files and exits with code 0; `--json` reports them in an `emptyMigrations` array.

A statement made only of comments, such as a block comment after the last `;`, is not executable either. chkit skips it instead of sending it to ClickHouse, which would reject it as `Empty query`.

### Backfill assertions

Mark a SQL guard with `assert_backfill` to verify that a data backfill completed before later statements run:

```sql
-- operation: assert_backfill key=table:analytics.events:backfill risk=caution
SELECT throwIf(countIf(format_version < 3) > 0, 'Complete the event backfill first')
FROM analytics.events;
```

The assertion succeeds when the query completes and is recorded in the journal. It does not wait for a table named `events:backfill` to appear. If the query throws, the migration stops before the next statement; after completing the backfill, run `chkit migrate --apply` again to resume at the failed assertion.

### Journal

Each migration has one row in the `_chkit_migrations` journal table in ClickHouse:

- `name` — the migration filename
- `applied_at` — time of the last change to the row
- `checksum` — SHA-256 hash of the file content
- `chkit_version` — the CLI version that wrote the row
- `migration_completed` — `true` once every statement has run
- `operations` — the progress of each statement (`completed`, `failed`, or `started`) while the migration runs
- `operation_fingerprints` — one fingerprint per entry of `operations`: a hash of the statement's SQL without comments and whitespace, which resumes and `--retry` check ([#599](https://github.com/obsessiondb/chkit/issues/599))

The first journal write of a release with #599 adds `operation_fingerprints` (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `ON CLUSTER` in cluster mode) to a journal an older release created; reads never alter the journal. A user that cannot `ALTER` the journal still migrates, without fingerprints, and `migrate` prints one warning line on stderr that says so (in `--json` mode too). Older releases read and write the journal as before: they name their columns, so a row they write has no fingerprints, and its statements are matched by position again.

The journal is written as each statement runs, not batched. The table is created in the database configured in `clickhouse.database` (it is not qualified with a database name, so on a shared/default-database setup it lives in `default._chkit_migrations`). The table name can be overridden with the `CHKIT_JOURNAL_TABLE` environment variable.

The table is a `ReplacingMergeTree` keyed by `name`: every change inserts a newer version of the row, and chkit reads it with `FINAL`, which returns the newest version. A `SELECT` without `FINAL` can show several rows per migration until background merges collapse them. `--abandon` writes a new version too, so it needs no privilege beyond the `INSERT` that every journal write uses.

### Concurrent runs

Only one `migrate --apply` (or `migrate --abandon --apply`) works on a journal at a time ([#716](https://github.com/obsessiondb/chkit/issues/716)). Before it applies anything, a run takes the migrate lock; a second run against the same journal stops with the code `migrate_locked` and names the run that holds it:

```
Another chkit migrate run holds the migrate lock on analytics._chkit_migrations:
  claim 3f1c…: pid 70784 on host ci-runner-7 (chkit 0.2.0), started 2026-11-11T09:03:01.959Z; last heartbeat 11s ago, free in 109s unless renewed
```

Plan runs, `status` and `check` take no lock and need no write access.

How it works:

- The lock is a row of the journal named `__chkit_migrate_lock__/<claim>`, with `migration_completed = false`, so every chkit release reads past it. A run writes its own claim, then reads every claim back; it holds the lock when no other claim is there. Two runs that claim at the same moment can both back off; each retries a few times within about 10 seconds before it gives up.
- After taking the lock, a run reads the journal again. A migration that another run applied in the meantime is skipped (`Skipping …: another migrate run applied it meanwhile.`); any other change to what the run showed stops it with `journal_changed` before it applies anything.
- The holder renews its claim every 10 seconds. A renewal counts when the holder reads its claim back with a newer version. A holder whose renewals have not counted for 60 seconds (a paused process, a lost connection), or whose claim was released with `--break-lock`, stops before its next request with `migrate_lock_lost`.
- A run that is killed or crashes keeps its claim. Once the server dates the claim's last heartbeat more than 120 seconds back, the next run watches it for 65 seconds; when it did not change, that run has stopped, so the next run releases the claim (and says so) and takes the lock. Watching makes this safe when the clocks of the replicas differ.
- On a multi-replica target the claims are read from every replica (see below), where the replica that accepted a claim always has it; a replica that does not answer fails the read. On a single endpoint without that fan-out, claims are written with `insert_quorum = 'auto'` and read with `select_sequential_consistency = 1`. A run that cannot read its own claim back right after writing it stops with `migrate_lock_unverifiable` instead of taking a lock it cannot check.

What the lock does not cover:

- A statement a run already sent keeps running on the server when that run is killed or loses the lock; ClickHouse cannot fence it. The next run handles it as it handles any statement of a stopped run (an [async](#async-operations-modeasync) statement is attached to; a sync one runs again). A process paused for more than its remaining 60 seconds between its check and its next request can still send that request.
- While the database in `clickhouse.database` does not exist yet, there is no journal to hold the lock: a first run that creates the database takes none, and says so on stderr.
- Releases before the lock do not take or check it, so the lock only keeps apart runs of releases that have it. `CHKIT_MIGRATE_LOCK=off` turns the lock off, as before this release; `migrate` then prints a warning on stderr.

To free the lock of a run you know has stopped, without waiting for it to expire, pass the claim from the error: `chkit migrate --apply --break-lock 3f1c…`. It releases only that claim and takes the lock; when another run holds the lock by then, it stops with `migrate_locked` as usual. Breaking the claim of a run that is still running lets both runs apply statements until that run's next renewal.

### Multi-replica targets

On a service whose endpoint spreads requests over several replicas, such as a multi-replica ObsessionDB service, a read can land on a replica that has not applied the latest DDL or journal write yet. chkit counts the replicas of the cluster set in `clickhouse.cluster`, or of the `default` cluster when none is set, once per run. With more than one replica:

- After each DDL statement, `migrate` waits until every replica shows the change (the new table, view, dictionary, or column, or the dropped one) before it runs the next statement. A replaced dictionary waits until every replica's catalog entry stores the same uuid, including when the only change is a SOURCE password that ClickHouse redacts from the stored definition. An `ALTER` that ran on a replica that had not applied the previous one could otherwise write back the old schema.
- Whether the journal has `operation_fingerprints` is read on every replica from `system.columns`, or, for a user that cannot read `system.columns`, from each replica's `CREATE` statement in `system.tables`. A column that only some replicas have yet is waited for; when a replica does not list the journal at all, `migrate` stops rather than read recorded fingerprints as missing.
- A column change waits for the definition, not only the column: `ADD COLUMN` and `MODIFY COLUMN` wait until every replica reports the same type, default, comment, and codec in `system.columns`, and `RENAME COLUMN` until no replica lists the old name. `ADD INDEX` and `DROP INDEX` wait for the index on every replica.
- After an `EXCHANGE TABLES`, `migrate` waits until every replica lists both tables with one uuid each, so the next statement cannot run on a replica that still has the old names. Before it retries an interrupted `EXCHANGE TABLES`, it waits for the same agreement and then runs the statement's `-- before-retry:` guard.
- The journal is read from every replica with `clusterAllReplicas`, keeping the newest version of each migration's row, so a lagging replica cannot make `migrate` replay a statement that already completed.
- An [async](#async-operations-modeasync) statement's status is read from `system.processes` and `system.query_log` of every replica, because the query runs only on the replica that received it.

When the cluster does not exist, has a single replica, or the user cannot query it, chkit reads the local replica as before.

When a wait times out, `migrate` stops with an error that names the object, such as `waitForTable: analytics.events not yet visible`, and does not record the migration as applied. The statement stays marked completed, so a re-run does not replay it: the re-run waits for it again before it runs the next statement, and stops with the same error if the change has still not reached every replica. Until its wait passes, the statement's journal entry has `lastError` `executed; waiting for the change to reach every replica`. A chkit release without this check does not write it, so a re-run does not wait again for a statement whose wait timed out under such a release.

On any target, a `MODIFY COLUMN` (or `COMMENT COLUMN`) also waits until `system.columns` shows what the statement sets: the default kind, the default expression (as the server formats it), the comment, and a removed default or codec. If the server accepts the statement without applying it, the wait times out after about 10 seconds and `migrate` stops with an error naming the replica and the field that differs. The statement stays marked completed, so fix the column by hand before you re-run. ObsessionDB currently ignores `MODIFY COLUMN ... EPHEMERAL <default>` ([#285](https://github.com/obsessiondb/chkit/issues/285)), so a migration that changes an `EPHEMERAL` column's default fails there with this error.

### Table scoping

The `--table` flag filters pending migrations to those containing operations targeting the matched tables. Migration SQL files are parsed for `-- operation:` comment markers to determine which tables they affect.

A hand-written migration with no `-- operation:` markers has no determinable target tables. Rather than silently skip it (which would leave pending work unapplied while appearing successful), `--table` **includes** such migrations and prints a warning listing them. In `--json` mode they are reported in an `undeterminedMigrations` array. If you do not want a hand-written migration applied under a scoped run, add an `-- operation: <type> key=table:<db>.<table> risk=<risk>` marker so its scope can be determined.

### Plugin hooks

The `onBeforeApply` plugin hook runs before each migration is executed and can transform the SQL statements. The `onAfterApply` hook runs after successful execution.

### Async operations (`mode=async`)

Long-running data operations — large `INSERT ... SELECT` loads, backfills — can be marked async so chkit submits the query without blocking on its HTTP response and polls server-side for progress. Add `mode=async` to the statement's `-- operation:` marker:

```sql
-- operation: load_table_data key=table:default.hits risk=caution mode=async
INSERT INTO default.hits SELECT * FROM s3(...);
```

When `chkit migrate --apply` encounters an async operation it:

1. Computes a deterministic `query_id` from `sha256('chkit:' + database + ':' + journal_table + ':' + migration_filename + ':' + statement_index)`, where `database` is the server's `currentDatabase()` and `journal_table` is the [journal](#journal) table (`_chkit_migrations`, or `CHKIT_JOURNAL_TABLE`). Runs of one migration file against other databases, or by other projects that keep their journal in the same database, never share a query id; a re-run against the same database and journal gets the same id. A statement the journal already tracks keeps the `queryId` it recorded, including one an earlier chkit derived from the file name and statement index alone.
2. Checks `system.processes` for an attempt with that id that is still running, and attaches to it instead of submitting again. On a [multi-replica target](#multi-replica-targets) the check reads every replica. When a replica cannot be read, `migrate` stops with an error before it runs `-- before-retry:` SQL or submits again; re-run it once the replica is back. The polls that follow skip a replica they cannot reach.
   When the journal records the statement as started (its run was killed, or gave up polling after a failed submit) and no replica still runs it, the check also reads that attempt's outcome from `system.query_log` on every replica, counting only queries that started no earlier than the start the journal records for the attempt (server clock, 2-second margin). A finished attempt is recorded as completed and the statement is not submitted again. A failed attempt, or one without a `query_log` entry yet, is retried as below. When the statement has `-- before-retry:` SQL, the attempt is recorded as failed before that SQL runs, so a later re-run cannot take a late `QueryFinish` of it for the outcome of rows the SQL removed. A started record that a chkit release without this check wrote is only checked in `system.processes`, as before: its start is on the client's clock, and a retry by that release may have run the `-- before-retry:` SQL without recording it. When the user cannot read `system.query_log`, `migrate` stops and names the missing `SELECT ON system.query_log` grant; any other failed read stops it the same way as an unreadable replica. `query_log` is written on a timer (every 7.5 seconds by default), so a re-run within that time of the attempt's end can still find no entry and run the statement again.
   An attach journals the attempt it attaches to as started, so a re-run after an interrupted attach finds its outcome the same way.
3. Otherwise submits the query without blocking on the HTTP response. A retry first waits until the server clock is 5 seconds past the check (the 2-second margin for the earlier attempt's replica and again for its own, plus the whole seconds `query_log` compares), so the start it records excludes every earlier attempt, including one that finished without chkit seeing it.
4. Polls every 5 seconds and prints a one-line progress update (`written=N.NM rows (N.N GiB), elapsed Ns`). Only `system.query_log` entries of queries that started no earlier than the server time read right before this submission, or than the attempt chkit attached to, count, with a 2-second margin for clock skew between replicas. An earlier attempt with the same id that started more than that margin before falls outside the bound; one a previous run polled to its end always does, as it started at least one poll interval earlier.
5. Records the journal entry on success, or throws the server's exception on failure.

When an earlier attempt of the statement failed, was interrupted, or was [abandoned](#abandoning-a-failed-migration), chkit runs the statement's `-- before-retry:` SQL before it submits the statement again. Put the line right after the `-- operation:` marker to undo a partial load:

```sql
-- operation: load_table_data key=table:default.hits risk=caution mode=async
-- before-retry: TRUNCATE TABLE default.hits
INSERT INTO default.hits SELECT * FROM s3(...);
```

A synchronous statement runs its `-- before-retry:` SQL the same way, before chkit runs it again after a failed or interrupted attempt; the first attempt never runs it. A guard that throws stops the retry, which is how a [cutover](/guides/data-preserving-migrations/) keeps a replayed `EXCHANGE TABLES` from swapping the tables back.

In `--json` mode, progress lines go to stderr, so stdout holds only the JSON output.

This unblocks two scenarios the synchronous path cannot handle:

- **Long loads through a proxy or load balancer with an HTTP request-duration ceiling** — the deterministic id lets a re-run attach to the still-running query on the server instead of cancelling and restarting it.
- **Transient client-side errors during a multi-minute load** — re-running `chkit migrate` resumes the in-flight query rather than starting over.

The annotation is opt-in and forward-compatible: statements without `mode=async` use the synchronous path, and an unknown mode value falls back to sync. Pair it with the [`-- log:` metadata header](#per-migration-metadata) to print context before the load begins.

### Insert barriers (`mode=barrier`)

A statement marked `mode=barrier` is a `SELECT` over `system.processes` that returns a `query_id` column. chkit runs it once, then again every second until none of the query ids of the first run is listed: it waits for the `INSERT`s that were running when the step started, not for the ones that start later. On a [multi-replica target](#multi-replica-targets) it reads every replica through `clusterAllReplicas`. After 10 minutes it stops with an error that lists the query ids still running; `chkit migrate --apply` then runs the barrier again from a fresh read. A barrier changes no object, so `migrate` does not wait for DDL propagation after it. `migrate --apply` therefore refuses, before it runs any pending migration, a statement marked `mode=barrier` that is not a `SELECT`, a `WITH ... SELECT` or a `FROM ... SELECT` (ClickHouse also reads `WITH ... INSERT INTO` and statements joined by `PARALLEL WITH`, which are not one), and exits with code 1 (`barrier_not_select` in `--json` mode). The error names the file, the statement and its marker. A [cutover](/guides/data-preserving-migrations/) uses two barriers: an `INSERT` builds its pipeline, including the materialized views it writes to, when it starts.

Before every `exchange_tables` statement, and at a cutover's first step, `migrate` reads `system.query_log` on every replica and stops when asynchronous inserts with `wait_for_async_insert = 0` reached one of the tables in the last 10 minutes: ClickHouse drops the buffered rows of such an insert when its table is swapped, and the writer is never told. A user who cannot read `system.query_log` gets a warning instead.

## Examples

**Preview pending migrations:**

```sh
chkit migrate --json
```

**Apply in CI:**

```sh
chkit migrate --apply --json
```

**Apply with destructive operations allowed:**

```sh
chkit migrate --apply --allow-destructive
```

**Drop a table larger than `max_table_size_to_drop`:**

```sh
chkit migrate --apply --allow-destructive --setting max_table_size_to_drop=0
```

**Scope to a specific table:**

```sh
chkit migrate --apply --table analytics.events
```

**Resume a failed migration after editing it:**

```sh
chkit migrate --apply --retry 20260929001110_funnel-model.sql
```

**Discard the partial run of a failed migration:**

```sh
chkit migrate --abandon 20260929001110_funnel-model.sql --apply
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (or no pending migrations) |
| 1 | Error: checksum mismatch on applied migrations, a pending migration without executable statements or with a `mode=barrier` statement that is not a `SELECT`, a failed statement, or a rejected `--retry` / `--abandon` request |
| 3 | Destructive operations blocked |

## JSON output

### Plan mode

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "plan",
  "scope": { "enabled": false },
  "pending": ["20260604104251_add_column.sql", "20260604105133_create_index.sql"]
}
```

### Plan mode with `--retry` and an empty migration

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "plan",
  "scope": { "enabled": false },
  "pending": ["20260929001110_funnel-model.sql", "20260930090000_backfill.sql"],
  "emptyMigrations": ["20260930090000_backfill.sql"],
  "retry": {
    "action": "resume",
    "migration": "20260929001110_funnel-model.sql",
    "previousChecksum": "7808…",
    "checksum": "3397…",
    "totalStatements": 16,
    "completedStatements": 4,
    "resumeAtStatement": 5,
    "unmarkedCompletedStatements": 0,
    "positionOnlyCompletedStatements": 0
  }
}
```

When `--retry` has no effect, `retry` is `{ "action": "none", "migration": "…", "reason": "…" }`, with `reason` one of `already_applied`, `not_in_scope`, `empty_migration`, `not_in_progress`, or `checksum_unchanged`. The execute payload, and the payload of a run with nothing pending (`"pending": []`), carry the same `retry` object.

### Successful execution

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "execute",
  "scope": { "enabled": false },
  "applied": [
    { "name": "20260604104251_add_column.sql", "appliedAt": "2025-06-15T10:30:00.000Z", "checksum": "a1b2c3..." }
  ]
}
```

### Checksum mismatch error

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "execute",
  "scope": { "enabled": false },
  "error": "Checksum mismatch detected on applied migrations",
  "checksumMismatches": [
    { "name": "20260604090000_init.sql", "expected": "abc123...", "actual": "def456..." }
  ]
}
```

### Empty migrations blocked

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "execute",
  "scope": { "enabled": false },
  "error": "Pending migrations contain no executable statements. Add SQL statements to each file or delete it.",
  "emptyMigrations": ["20260930090000_backfill.sql"]
}
```

### Destructive operations blocked

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "execute",
  "scope": { "enabled": false },
  "error": "Blocked destructive migration execution. Re-run with --allow-destructive or set safety.allowDestructive=true after review.",
  "destructiveMigrations": ["20260605112000_drop_old_table.sql"],
  "destructiveOperations": [
    {
      "migration": "20260605112000_drop_old_table.sql",
      "type": "drop_table",
      "key": "default.old_table",
      "risk": "danger",
      "warningCode": "drop_table_data_loss",
      "reason": "...",
      "impact": "...",
      "recommendation": "...",
      "summary": "..."
    }
  ]
}
```

### Abandon

In JSON mode, without `--apply`, `mode` is `plan` and nothing changes; with `--apply`, it is `execute`. `operations` is the progress of each statement before the reset. `completedStatements` also counts statements that completed before an earlier `--abandon`: their `lastError` reads `abandoned via chkit migrate --abandon (was completed)`, and abandoning again keeps it.

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "execute",
  "scope": { "enabled": false },
  "abandon": {
    "migration": "20260929001110_funnel-model.sql",
    "checksum": "7808…",
    "completedStatements": 1,
    "operations": [
      { "operationIndex": 0, "operationKey": "table:analytics.events", "operationType": "alter_table_add_column", "queryId": "", "status": "completed", "startedAt": "2026-09-29 00:11:10.120", "finishedAt": "2026-09-29 00:11:10.180", "lastError": "" },
      { "operationIndex": 1, "operationKey": "view:analytics.funnel", "operationType": "create_view", "queryId": "", "status": "failed", "startedAt": "2026-09-29 00:11:10.240", "finishedAt": "2026-09-29 00:11:10.260", "lastError": "Unknown table expression identifier 'analytics.funnel_steps' …" }
    ]
  }
}
```

### Errors

A failure that stops the command prints the standard error envelope:

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "in_progress_checksum_mismatch",
    "message": "Migration 20260929001110_funnel-model.sql has in-progress journal state for checksum 7808…"
  }
}
```

| Code | When |
|------|------|
| `in_progress_checksum_mismatch` | The file of an in-progress migration changed after some of its statements ran, and `--retry` was not given for it |
| `statement_split_changed` | Another chkit release applied part of the migration, and the statements it recorded are not the same in the current split (a `;`, quote or `/*` inside a `//` or `#` comment, [#562](https://github.com/obsessiondb/chkit/issues/562)), or the file is unchanged but a statement recorded as completed or running no longer has the SQL it ran with ([#599](https://github.com/obsessiondb/chkit/issues/599)) |
| `barrier_not_select` | A pending migration marks a statement `mode=barrier` that is not a `SELECT` ([insert barriers](#insert-barriers-modebarrier)); nothing was applied |
| `retry_mismatch` | `--retry`: a statement that completed, or an async statement that may still be running, no longer matches the edited file (position, marker or SQL), or the edit left fewer statements with a marker that a completed statement shares |
| `migration_not_found` | `--retry` names a file that is not in the migrations directory |
| `migration_not_in_progress` | `--abandon`: the journal has no in-progress state for the migration |
| `migration_already_applied` | `--abandon`: the migration is already applied |
| `migrate_locked` | Another run holds the [migrate lock](#concurrent-runs); nothing was applied |
| `migrate_lock_lost` | This run's lock renewals did not count for 60 seconds, or another run broke its claim; the run stopped before its next request |
| `migrate_lock_unverifiable` | A read right after this run wrote its lock claim did not return it; nothing was applied |
| `journal_changed` | Another run changed the journal between the plan and the lock in a way the plan does not cover; nothing was applied |
| `invalid_usage` | `--abandon` combined with `--retry`, `--table`, or `--allow-destructive`, or an empty migration name |

Other failures, such as a statement that ClickHouse rejects, use the code `error`.

## Per-migration metadata

Migration files can declare optional metadata in the leading comment header. `chkit migrate` reads these keys and uses them to inform the user before the migration runs.

| Key | Effect |
|-----|--------|
| `log` | Printed to stdout immediately before the migration is applied. Use it to flag long-running or risky operations. |

Example header:

```sql
-- chkit-migration-format: v1
-- log: Loading the full ClickBench dataset (~100M rows). Expected duration: 3-5 minutes.
-- generated-at: ...
-- ...

INSERT INTO default.hits SELECT * FROM s3(...);
```

When the migration is listed (plan mode and as part of `--apply`):

```
Pending migrations: 1
- 20260525133130_load_clickbench_data.sql
    Loading the full ClickBench dataset (~100M rows). Expected duration: 3-5 minutes.
```

In `--apply` mode the log line is also re-printed immediately before each migration is executed, so the message stays close to the related work in CI logs:

```
  Loading the full ClickBench dataset (~100M rows). Expected duration: 3-5 minutes.
Applied: 20260525133130_load_clickbench_data.sql
```

Metadata keys are parsed from contiguous `-- key: value` comments at the top of the file (blank lines are tolerated) and stop at the first non-comment line. Unknown keys are ignored, so adding new keys in future releases is backwards-compatible.

## Related commands

- [The migration workflow](/guides/migration-workflow/) — the full generate → commit → migrate loop, and hand-written migrations
- [`chkit generate`](/cli/generate/) — produce migration files from schema changes
- [`chkit status`](/cli/status/) — check migration state without applying
- [`chkit check`](/cli/check/) — CI gate that evaluates pending migrations and checksums
