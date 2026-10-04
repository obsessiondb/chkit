# Attio CRM ingestion

This is your source code: edit the API readers, schemas, views, and `pipeline.ts` directly. It uses the [chkit CLI](https://www.npmjs.com/package/chkit), `@chkit/core`, and `@chkit/plugin-ingest`; there is no runtime connection to the template registry.

## First run

Set `ATTIO_API_TOKEN` in your execution environment and configure the project's direct ClickHouse connection. A single-workspace API token works; an OAuth access token also works, but this template does not implement OAuth issuance or refresh. See [Attio authentication](https://docs.attio.com/rest-api/guides/authentication).

### Create an Attio API key

1. As a workspace admin, open the workspace-name dropdown in Attio and select **Workspace settings**.
2. Open **Developers**, select **+ New access token**, and name the token, for example **chkit ClickHouse**.
3. Grant the read scopes in the resource table below for the streams to run.
4. Click the token on the Developers page to copy it. Set `ATTIO_API_TOKEN` in the project's `.env` file or the scheduler's secret environment.

See Attio's [API key instructions](https://attio.com/help/reference/apps/generating-an-api-key). Use a single-workspace API token for this setup; OAuth token creation and refresh require a separate application flow.

Bun loads a project `.env` automatically. With Node or a scheduler, explicitly supply environment variables using that runtime's environment-loading mechanism. `.env.example` only lists required variable names; it does not load values. Schema imports, `check`, and `ingest list` do not read the token or make API requests.

Review `config.ts` before the first migration. The default target database is `default`; raw table and view names begin with `attio_`. Use a stable, non-secret `sourceId` for this source instance. For another installation, give it a distinct source ID and table prefix or database before exporting its pipeline. Changing these after ingestion changes stream/storage identities and requires a deliberate migration.

```sh
bunx chkit check
bunx chkit ingest list --tag provider:attio
bunx chkit generate --name add_attio
# Review the generated SQL.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:attio
```

The schema uses native JSON (ClickHouse 25.3 or newer). A direct ClickHouse connection is required; workbench-only execution is not supported. Use an external scheduler to repeat the run command, with one ingestion process per project/target at a time.

## Included resources

All nine streams perform checkpointed full scan cycles. Every stream runs independently; a new cycle discovers its own parent objects/lists. After interruption, parent-scoped streams keep the frozen parent set and resume after the last completely loaded parent. The unfinished parent restarts at offset zero because offsets into mutable collections are not durable change cursors.

| Stream tag | Raw table | Required Attio scopes |
| --- | --- | --- |
| `resource:objects` | `attio_objects_raw` | `object_configuration:read` |
| `resource:object_attributes` | `attio_object_attributes_raw` | `object_configuration:read` |
| `resource:records` | `attio_records_raw` | `object_configuration:read`, `record_permission:read` |
| `resource:lists` | `attio_lists_raw` | `list_configuration:read` |
| `resource:list_attributes` | `attio_list_attributes_raw` | `list_configuration:read` |
| `resource:entries` | `attio_entries_raw` | `list_configuration:read`, `list_entry:read` |
| `resource:notes` | `attio_notes_raw` | `note:read`, `object_configuration:read`, `record_permission:read` |
| `resource:tasks` | `attio_tasks_raw` | `task:read`, `object_configuration:read`, `record_permission:read`, `user_management:read` |
| `resource:members` | `attio_members_raw` | `user_management:read` |

Records include all accessible standard and custom objects returned by the [objects API](https://docs.attio.com/rest-api/endpoint-reference/objects/list-objects). Standard `users` records are distinct from [workspace members](https://docs.attio.com/rest-api/endpoint-reference/workspace-members/list-workspace-members). Attribute streams include archived attribute definitions; separate select-option/status catalogs and historical attribute values are not fetched. Active record/entry payloads retain their returned select/status values.

The template does not collect meetings, call recordings, transcripts, emails, files, comments, or historical attribute values. It does not receive webhooks or detect source deletions/merges. Coverage is limited to data the token can access. A permission error fails that stream with a diagnostic; it is never treated as an empty dataset.

API references: [attributes](https://docs.attio.com/rest-api/endpoint-reference/attributes/list-attributes), [records](https://docs.attio.com/rest-api/endpoint-reference/records/list-records), [lists](https://docs.attio.com/rest-api/endpoint-reference/lists/list-all-lists), [entries](https://docs.attio.com/rest-api/endpoint-reference/entries/list-entries), [notes](https://docs.attio.com/rest-api/endpoint-reference/notes/list-notes), [tasks](https://docs.attio.com/rest-api/endpoint-reference/tasks/list-tasks).

## Customize the source

Each file in `sources/` contains one resource's raw table and reader, such as `sources/notes.ts`, `sources/tasks.ts`, or `sources/members.ts`. `sources/records.ts` also defines the people, company, and deal views. `client.ts` shares HTTP and pagination logic; `checkpoints.ts` validates scan state and selection scope; `pipeline.ts` composes the nine streams.

Remove an entry from `pipeline.ts` to stop collecting that resource. Keep its schema export in `index.ts` to preserve already collected data. Removing schema exports can generate destructive migration operations, which should be reviewed. After removing a resource's stream and schema export, its local files can also be deleted.

Set `objects` and `lists` in `config.ts` to arrays of API slugs or IDs to restrict discovery. `undefined` means all accessible parents; `[]` means none. Unknown configured parents fail visibly. Object selection affects objects, object attributes, and records. List selection affects lists, list attributes, and entries. Notes, tasks, and members remain workspace-wide; customize their readers separately if narrower scope is needed.

To run only records:

```sh
bunx chkit ingest run --tag provider:attio --tag resource:records
```

`pageSize` defaults to 500. Notes have a separate `notesPageSize` of 50, the documented maximum. Requests go through the ingestion executor's retry/cancellation context, with a 30-second request timeout. The serial pipeline leaves a 25ms gap before each request and a 125ms gap for notes; raising concurrency requires revisiting rate control. `429` responses retain `Retry-After` for executor backoff. Attio also limits query complexity; a permanently expensive query may need simpler filters/sorts rather than repeated retries. See [rate limits](https://docs.attio.com/rest-api/guides/rate-limiting).

## Stored data and editable views

Each raw table contains a stable `id`, native JSON `raw`, and chkit batch/run/ingestion-time metadata. The key includes source identity, resource kind, workspace ID, and every relevant object/list/entity ID. Names, emails, and domains are never keys.

The complete returned entity is retained under `raw.data`. The envelope adds `source_id`; record and object-attribute rows also include `object_slug`, and list-entry/list-attribute rows include `list_slug`. No custom attributes or multivalued arrays are flattened away. For example:

```sql
SELECT id, raw.data, _chkit_ingested_at
FROM default.attio_records_raw FINAL;
```

`sources/records.ts` defines three ordinary `FINAL` views:

| View | Editable projection |
| --- | --- |
| `attio_people` | name, email address array, company record ID array |
| `attio_companies` | name, domain array, description |
| `attio_deals` | name, stage, nullable numeric value, currency code, company/people record ID arrays |

All include the stable row `id`, `source_id`, `workspace_id`, `object_id`, `record_id`, nullable `created_at`, `web_url`, and `_chkit_ingested_at`. Missing optional strings yield empty strings, absent arrays yield empty arrays, and absent/unparseable dates or deal amounts yield null. A workspace without deals simply has an empty deals view. Edit these SQL projections to expose your custom fields, then generate and review a migration. The original payload remains available for further projections.

The journal stores scan cycles, selected parent IDs/slugs, completed parent IDs, and terminal completion. Parent-completion markers flush all preceding rows before advancing state. Workspace-wide notes/tasks/members restart an interrupted collection at offset zero; a completed cycle starts a fresh full read on the next run. New parents discovered during an interrupted cycle wait until that next cycle. An empty scan still records completion. Changing the object/list selection rejects the saved scope; restore it or use a new source identity for a deliberate fresh scan. A frozen parent that disappears or loses access fails visibly instead of being marked complete. Returned child workspace and parent IDs must match the frozen discovery identity; switching account tokens cannot publish rows from a different workspace under that frontier. Existing installations without a checkpoint start their first checkpointed cycle normally.

These views show the latest **observed** version per ID, not a guaranteed snapshot of Attio now. Full reads update returned IDs without clearing tables. Deleted, merged, inaccessible, or deselected entities remain until you implement reconciliation. Data is published batch by batch, so a failed run may have loaded some updates. Offset pagination over changing source data can miss or duplicate entities within a scan. There is no universal modification cursor, atomic snapshot replacement, source-version ordering, or complete change history in this template. Checkpoints reduce repeated parent work; they do not turn offset scans into provider snapshots. No data-bearing chunk uses a page offset as its identity.

## Fixture tests

Install the optional test suite with `bunx chkit add attio --with-tests`, then run:

```sh
bun test src/integrations/attio/tests/attio.test.ts
```

For a custom install path, point the command at that folder's `tests/attio.test.ts`. Tests mock Attio HTTP responses and use in-memory ingestion destinations and journals. They require Bun but no Attio credentials or ClickHouse server. The fixture suite checks resource coverage, pagination, preserved custom fields, repeat runs, cancellation, errors, serialized checkpoint resumption, frozen parents, safe restart of unfinished offsets, empty completion, and rows loaded before a journal failure. Adjust the fixtures and expectations when customizing the source.

## Smoke check

After a migration and one successful run, inspect `chkit ingest status --tag provider:attio` and query `SELECT count() FROM default.attio_records_raw FINAL`. Compare a known record's retained `raw.data` with its Attio API response. Run again after changing that record and verify its view reflects the new observation. This smoke check needs a real test workspace and database; the registry's sanitized fixture tests do not assert complete live API coverage.
