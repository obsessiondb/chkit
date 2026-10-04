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

Each configured object type has its own records and object-attributes streams. The defaults create separate People and Companies readers; tasks, notes, members, and the object/list catalogs have workspace-wide streams. Each configured list similarly gets independent entries and list-attributes streams. The number of streams depends on `objects` and `lists`; the default configuration has nine streams writing to seven resource tables. All nine raw tables are defined, including entries and list attributes, whose readers are enabled by configuring `lists`.

Every stream uses `fullSync()` and the existing pagination helper. A records reader fetches one configured object type, such as People, rather than looping over all object types. An interrupted stream restarts its collection at offset zero because Attio's mutable offsets are not durable cursors. Each stream has its own execution journal; no parent-completion ledger or custom scan state is needed.

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

The objects and lists catalog streams retain all accessible metadata. Records and attributes are fetched only for the object types configured in `objects`; entries and list attributes require configured `lists`. Standard `users` records, when explicitly configured, are distinct from [workspace members](https://docs.attio.com/rest-api/endpoint-reference/workspace-members/list-workspace-members). Attribute streams include archived attribute definitions; separate select-option/status catalogs and historical attribute values are not fetched. Active record/entry payloads retain their returned select/status values.

The template does not collect meetings, call recordings, transcripts, emails, files, comments, or historical attribute values. It does not receive webhooks or detect source deletions/merges. Coverage is limited to data the token can access. A permission error fails that stream with a diagnostic; it is never treated as an empty dataset.

API references: [attributes](https://docs.attio.com/rest-api/endpoint-reference/attributes/list-attributes), [records](https://docs.attio.com/rest-api/endpoint-reference/records/list-records), [lists](https://docs.attio.com/rest-api/endpoint-reference/lists/list-all-lists), [entries](https://docs.attio.com/rest-api/endpoint-reference/entries/list-entries), [notes](https://docs.attio.com/rest-api/endpoint-reference/notes/list-notes), [tasks](https://docs.attio.com/rest-api/endpoint-reference/tasks/list-tasks).

## Customize the source

Each file in `sources/` contains one resource's raw table and reader, such as `sources/notes.ts`, `sources/tasks.ts`, or `sources/members.ts`. `sources/records.ts` also defines the people, company, and deal views. `client.ts` shares HTTP, validation, and pagination logic; `pipeline.ts` creates streams from the explicit object/list configuration.

Remove an entry from `pipeline.ts` to stop collecting that resource. Keep its schema export in `index.ts` to preserve already collected data. Removing schema exports can generate destructive migration operations, which should be reviewed. After removing a resource's stream and schema export, its local files can also be deleted.

Set `objects` and `lists` in `config.ts` to explicit arrays of API slugs or IDs. Defaults are `objects: ['people', 'companies']` and `lists: []`. Add `deals` or a custom object slug to collect that type; add list slugs or IDs to collect entries. `[]` disables the corresponding object/list child streams. The stream graph is built from these arrays without API discovery, so schema imports and `ingest list` remain offline. A reader resolves its one configured slug or ID through Attio and fails visibly if it is unknown or inaccessible. The objects/lists catalogs still collect all accessible metadata; notes, tasks, and members remain workspace-wide.

Object streams use `<sourceId>.records.<ref>` and `<sourceId>.object_attributes.<ref>`. List streams use `<sourceId>.entries.<ref>` and `<sourceId>.list_attributes.<ref>`. Each has independent journal progress even though streams of the same resource write to the same raw table. Keep configured references stable: changing from a slug to its equivalent ID changes the stream ID.

To run all configured records streams:

```sh
bunx chkit ingest run --tag provider:attio --tag resource:records
```

To run only People records:

```sh
bunx chkit ingest run --tag provider:attio --tag resource:records --tag object:people
```

Record streams carry `resource:records` and `object:<ref>`. Object-attribute streams carry `resource:object_attributes` and `object:<ref>`; entries/list-attribute streams carry their resource tag and `list:<ref>`.

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

All include the stable row `id`, `source_id`, `workspace_id`, `object_id`, `record_id`, nullable `created_at`, `web_url`, and `_chkit_ingested_at`. Missing optional strings yield empty strings, absent arrays yield empty arrays, and absent/unparseable dates or deal amounts yield null. The deals view remains empty until `deals` is configured and observed; previously loaded deal rows remain when it is later deselected. Edit these SQL projections to expose your custom fields, then generate and review a migration. The original payload remains available for further projections.

The executor journal records per-stream execution and load completion, including successful empty reads. Every scheduled run reads each selected stream from the beginning. An interruption in Companies affects that stream's completion independently of People; the next Companies attempt starts at offset zero. The reader validates returned child workspace and parent IDs against its resolved object/list before publishing rows. The journal stores no Attio-specific cycle, parent inventory, or offset checkpoint. These full-sync readers ignore date bounds; date-range backfills are not supported.

Version `0.2.0` changes records, object-attributes, entries, and list-attributes stream IDs to the per-type/per-list forms above. Those new stream IDs begin with fresh journal progress. Raw table schemas, row identities for the same `sourceId`, and all three views remain unchanged. The previous `0.1.3` artifact remains available. If upgrading from its checkpointed-scan preview, the unchanged workspace stream IDs would have saved a different strategy; use a new `sourceId` and review the existing rows because source identity is also part of every raw row ID. Installed source is editable and is not automatically replaced by a registry update.

These views show the latest **observed** version per ID, not a guaranteed snapshot of Attio now. Full reads update returned IDs without clearing tables. Deleted, merged, inaccessible, or deselected entities remain until you implement reconciliation. Data is published batch by batch, so a failed run may have loaded some updates. Offset pagination over changing source data can miss or duplicate entities within a read. There is no universal modification cursor, atomic snapshot replacement, source-version ordering, or complete change history in this template. No data-bearing chunk uses a page offset as its identity.

## Fixture tests

Install the optional test suite with `bunx chkit add attio --with-tests`, then run:

```sh
bun test src/integrations/attio/tests/attio.test.ts
```

For a custom install path, point the command at that folder's `tests/attio.test.ts`. Tests mock Attio HTTP responses and use in-memory ingestion destinations and journals. They require Bun but no Attio credentials or ClickHouse server. The fixture suite checks per-type stream selection, independent pagination, preserved custom fields, repeat runs, cancellation, errors, safe offset-zero restart, successful empty reads, and rows loaded before a journal failure. Adjust the fixtures and expectations when customizing the source.

## Smoke check

After a migration and one successful run, inspect `chkit ingest status --tag provider:attio` and query `SELECT count() FROM default.attio_records_raw FINAL`. Compare a known record's retained `raw.data` with its Attio API response. Run again after changing that record and verify its view reflects the new observation. This smoke check needs a real test workspace and database; the registry's sanitized fixture tests do not assert complete live API coverage.
