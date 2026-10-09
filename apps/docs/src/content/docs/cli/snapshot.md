---
title: "chkit snapshot"
description: "Rebuild snapshot.json from your schema definitions, for example after two branches conflict on it."
sidebar:
  order: 12
---

Rewrites `chkit/meta/snapshot.json` from your schema definitions without writing a migration, for example when two branches that each ran `chkit generate` conflict on it.

## Synopsis

```
chkit snapshot rebuild [flags]
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dryrun` | boolean | `false` | Print the report without writing `snapshot.json` |

Global flags documented on [CLI Overview](/cli/overview/#global-flags). `rebuild` always rewrites the whole snapshot and rejects `--table`.

## Behavior

### Why snapshot.json conflicts

`chkit generate` rewrites the whole `snapshot.json` on every run, including its `generatedAt` timestamp. When two branches each run `generate`, the branch that merges or rebases second conflicts on the file, even when the branches changed unrelated objects. Git merges the JSON as plain text: a conflict inside the `definitions` array can split an entry between the two sides, and taking either side drops the other branch's changes.

While the file has conflict markers, `generate`, `migrate` (except `migrate --abandon`), `drift`, and `check` stop with `Snapshot ... contains unresolved merge conflict markers`.

### Rebuild

`chkit snapshot rebuild` writes the snapshot that `chkit generate` would write for your current schema definitions. It never writes a migration file and never connects to ClickHouse.

1. Loads the config and schema definitions and runs the `onConfigLoaded` and `onSchemaLoaded` plugin hooks, like `generate`. A schema file that does not load, for example one that still has conflict markers, stops the command before anything is written.
2. Validates the definitions. A validation error stops the command before anything is written.
3. Compares the existing `snapshot.json` with the rebuilt definitions, entry by entry.
4. Writes `snapshot.json`, unless `--dryrun` is set or the existing file already matches.

The report lists each entry that differs by its key: `+` added, `-` removed, `~` changed (for example `~ view:app.events_by_source`). The comparison ignores `generatedAt`, key order, and formatting. If the existing file has unresolved merge conflict markers, is empty, or cannot be read as a snapshot, the report says so and the command rebuilds without a comparison. With nothing to compare, `--dryrun` only checks that the definitions load and pass validation; review the rebuilt file with git instead (see [Review the result](#review-the-result)).

Config functions (`defineConfig((env) => ...)`) and plugin hooks receive `command: 'snapshot'` during a rebuild. A config or plugin that only acts when the command is `generate` makes the rebuilt snapshot differ from the one `generate` writes, so treat `snapshot` like `generate`.

:::caution
A rebuilt snapshot records every schema definition as already migrated. `chkit generate` diffs against the snapshot, so it never writes a migration for a change that a rebuild absorbed. Rebuild only when every schema change already has a migration file.
:::

### Before you rebuild

- **Every branch is fully generated.** On each branch, `chkit generate --dryrun` reports 0 operations before you merge or rebase. Then every schema change on either branch has a migration file.
- **Generate after upgrading chkit.** A new chkit version can store a definition in a different canonical form and plan a repair migration for it. Run `chkit generate` and commit its migration before you rebuild; a rebuild would absorb the repair.

### When not to rebuild

- **The file is damaged but committed, and no merge or rebase is in progress.** Restore the committed version with `git checkout HEAD -- chkit/meta/snapshot.json`. During a merge or rebase, `HEAD` holds only one side of the conflict.
- **You abandoned a failed migration to generate it again** (for example with `chkit migrate --abandon`). Restore `snapshot.json` from git to its state before that migration was generated. A rebuild records the current schema, so the following `generate` would plan nothing.
- **You scope `generate` with `--table`.** A scoped `generate` leaves the entries of other tables behind the schema on purpose. A rebuild records every definition and does not support `--table`.

### Review the result

`chkit generate --dryrun` reports 0 operations right after a rebuild by construction, so it does not check the result. Review the report instead: every listed entry must come from a migration file of one of the branches. After a conflict, compare the rebuilt file with both sides before you commit it. During a merge the other side is `MERGE_HEAD`; during a rebase it is `REBASE_HEAD`, the commit being replayed:

```sh
git diff HEAD -- chkit/meta/snapshot.json
git diff MERGE_HEAD -- chkit/meta/snapshot.json    # during a merge
git diff REBASE_HEAD -- chkit/meta/snapshot.json   # during a rebase
```

Every entry that differs from one side must come from a migration file of the other side. For tables, [`chkit drift`](/cli/drift/) against an environment where every migration is applied confirms the shape, matching columns by name. `drift` does not compare column order or view queries.

### When both branches change the same object

`chkit migrate` applies pending migration files in filename order, and the version of an object that is applied last wins. When both branches changed the same table or view, an environment that applied one branch before the other was merged runs the two migrations in a different order than a fresh environment, so environments can end up with different versions of that object. A rebuild records the definition from your merged schema files as applied, and `chkit generate` plans nothing for it afterwards. For a table, this matters only for what both branches changed, such as the same column. Changes to different columns give the same columns in either order, but when each branch adds a column, the new columns can end up in a different order in each environment: chkit appends an added column, and `drift` compares columns by name, so it does not report the difference. The order shows in `SELECT *` and in an `INSERT` without a column list.

After the rebuild, add a migration that sorts after both branches' migrations and applies the merged definition of that object again, so every environment converges:

```sh
chkit generate --empty --name reapply_events_by_source
```

Copy the object's statements from the branch migrations into the new file and adjust them to the merged definition: the `DROP VIEW IF EXISTS` and `CREATE VIEW IF NOT EXISTS` pair for a view, or the `ALTER TABLE` statements for a table. Keep the `DROP` for a view: on its own, `CREATE VIEW IF NOT EXISTS` does nothing where the view exists. Copy each statement with its `-- operation:` comment line; without it, `chkit migrate --apply` treats a `DROP VIEW` as unmarked destructive SQL and requires `--allow-destructive`.

```sql
-- operation: drop_view key=view:app.events_by_source risk=caution
DROP VIEW IF EXISTS app.events_by_source;

-- operation: create_view key=view:app.events_by_source risk=caution
CREATE VIEW IF NOT EXISTS app.events_by_source AS
SELECT source, count() AS total FROM app.events GROUP BY source;
```

Removing the entry from `snapshot.json` instead does not help: `generate` would plan a `CREATE ... IF NOT EXISTS`, which does nothing where the object exists.

## Examples

**Resolve a conflicted snapshot during a rebase:**

```sh
chkit snapshot rebuild
git diff HEAD -- chkit/meta/snapshot.json
git diff REBASE_HEAD -- chkit/meta/snapshot.json
git add chkit/meta/snapshot.json
git rebase --continue
```

**Resolve a conflicted snapshot during a merge:**

```sh
chkit snapshot rebuild
git diff HEAD -- chkit/meta/snapshot.json
git diff MERGE_HEAD -- chkit/meta/snapshot.json
git add chkit/meta/snapshot.json
git commit --no-edit
```

**Preview a rebuild as JSON:**

```sh
chkit snapshot rebuild --dryrun --json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Snapshot written, already up to date, or dry run |
| 1 | Schema file that does not load (for example with conflict markers), validation error, usage error (missing or unknown subcommand, `--table`), or config error |

## JSON output

### Rebuild

```json
{
  "command": "snapshot",
  "schemaVersion": 1,
  "subcommand": "rebuild",
  "mode": "write",
  "snapshotFile": "/repo/chkit/meta/snapshot.json",
  "written": true,
  "definitionCount": 16,
  "previous": {
    "status": "parsed",
    "added": ["table:app.users", "view:app.users_daily"],
    "removed": [],
    "changed": ["view:app.events_by_source"]
  }
}
```

`mode` is `plan` with `--dryrun`, which never writes. `written` is `false` when the existing snapshot already matches. `previous.status` is one of:

| Status | Meaning | Extra fields |
|--------|---------|--------------|
| `missing` | No `snapshot.json` existed | none |
| `parsed` | Compared with the existing snapshot | `added`, `removed`, `changed` |
| `conflicted` | The file had unresolved merge conflict markers; not compared | none |
| `unreadable` | The file was empty, invalid JSON, or not a chkit snapshot; not compared | `reason`: `empty`, `invalid_json`, or `invalid_shape` |

### Validation error

```json
{
  "command": "snapshot",
  "schemaVersion": 1,
  "error": "validation_failed",
  "issues": [{ "code": "...", "message": "..." }]
}
```

## Related commands

- [The migration workflow](/guides/migration-workflow/#working-on-parallel-branches) — the flow for schema changes on parallel branches
- [`chkit generate`](/cli/generate/) — writes the snapshot on every run
- [`chkit drift`](/cli/drift/) — compare the snapshot with a database where every migration is applied
