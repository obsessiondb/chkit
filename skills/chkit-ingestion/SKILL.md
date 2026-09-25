---
name: chkit-ingestion
description: Author or adapt API ingestion sources with @chkit/plugin-ingest. Use for chkit streams, readers, pagination, incremental checkpoints, destinations, and loader choices; excludes generated insert helpers from plugin-codegen.
---

# chkit ingestion authoring

Implement a source reader with finite runs. Inspect the installed plugin version, config, and existing streams; preserve the user's choices.

## Decide before coding

Establish auth, response shape, pagination, record IDs, change filters/cursors, deletes, volume, and freshness needs from code and provider docs. Ask for missing facts that affect implementation. Verify provider capabilities.

Treat stored shape and mapping together: prefer raw objects plus a SQL view when the shape may evolve and storage is affordable; map inside `read` for a known schema. Model warehouse entities separately; embed bounded child collections when consumers need complete documents. A unified document table is a specialized retrieval model.

Start with the default loader and a full sync for small datasets; add provider-supported incremental reads when needed. Explain consequential choices at their implementation step, introducing tuning and custom interfaces only as required.

## Read only the relevant docs

Use local `apps/docs/src/content/docs/api-sync/` or these URLs. Match the installed version; inspect exported types if docs are unavailable.

- [Quickstart](https://chkit.obsessiondb.com/api-sync/quickstart.md): complete config and first sync.
- [Readers](https://chkit.obsessiondb.com/api-sync/readers.md): fetching, auth, pagination, SDKs.
- [Destinations](https://chkit.obsessiondb.com/api-sync/destinations.md): raw or shaped rows, relationships, current state/history, tombstones.
- [Incremental syncs](https://chkit.obsessiondb.com/api-sync/incremental-syncs.md): full, timestamp, cursor, custom strategies.
- [Loading](https://chkit.obsessiondb.com/api-sync/loading.md): batching and custom loader contracts.
- [Operations](https://chkit.obsessiondb.com/api-sync/operations.md): retries, scheduling, backfills, limits.
- [Testing](https://chkit.obsessiondb.com/api-sync/testing.md): offline failure and replay checks.

## Preserve these contracts

- TypeScript and direct ClickHouse config are required. Replace `schema` with `entry`, preserving schema exports and exporting active pipelines. Migrations create destinations.
- Stream IDs own checkpoints: keep them stable and account-scoped. Pipelines group streams without dependency ordering.
- Use `context.attempt`/`paginate`, forward cancellation, and throw `HttpError.fromResponse` for HTTP failures. Yield bounded chunks.
- Enforce both time bounds. Persist only provider-guaranteed, complete resume state after all preceding rows are represented; the executor commits it after writes.
- Custom tables need `ingestionColumns`. Prefer `simpleLoader`; custom loaders must preserve write identity and acknowledge publication before returning receipts.
- Delivery is at-least-once: choose reconciliation keys/versioning. Declare chunk `id` only for stable logical intervals; avoid volatile mapped fields.
- Prefer tombstones for logical deletion. Fetch deletion signals explicitly; full sync does not reconcile missing IDs. Never infer deletions from partial scans. Complete required child reads before yielding a root.
- Use an external scheduler and run one process per project/target, including backfills.

## Deliver and verify

Deliver definitions, config, and run/query commands. Check `chkit ingest list` and `chkit check --offline`; test empty input, pagination, checkpoint boundaries, and failure replay with fixtures. Keep live writes within authorization. Report verified behavior and limitations.
