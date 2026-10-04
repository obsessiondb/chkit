---
name: chkit-ingestion
description: Author or improve API ingestion sources and registry integrations with @chkit/plugin-ingest. Use for provider-specific sync, pagination, durable checkpoints, recovery, raw destinations, and loader choices; excludes generated insert helpers from plugin-codegen.
---

# chkit ingestion authoring

Implement a recoverable source reader with finite runs. Inspect the installed plugin version, config, and existing streams; preserve the user's choices.

## Decide before coding

Establish auth, response shape, pagination, record IDs, change filters/cursors, deletes, volume, and freshness needs from code and provider docs. Ask for missing facts that affect implementation. Verify provider capabilities.

Treat stored shape and mapping together: prefer raw objects plus a SQL view when the shape may evolve and storage is affordable; map inside `read` for a known schema. Model warehouse entities separately; embed bounded child collections when consumers need complete documents. A unified document table is a specialized retrieval model.

Choose the strongest appropriate sync mechanism the provider actually supports: a change feed or sync token, reliable modification windows, or full reads with safe replay. A simple full read is appropriate when the API lacks reliable change selection and its cost is acceptable, as well as for small catalogs or explicitly requested prototypes. Use the default loader unless another publication contract is needed. Explain consequential choices and coverage limits.

Choose stream boundaries that match the entities users sync independently. Several streams can write to one raw table; table grouping does not require one reader to traverse every entity type. Prefer existing `paginate()` and incremental strategies. Add custom state only when a provider's recovery contract needs progress beyond the executor's journal; ordinary `fullSync()` already records successful work, including empty reads. Put repeated generic mechanics in the library when the existing API cannot express them concisely.

## Registry quality bar

Before creating or materially changing an official registry integration, read [Stable sync design and verification](references/stable-sync.md). Registry providers are reusable implementations of supported capabilities: deliver robust bootstrap, incremental selection where available, durable recovery, and reconciliation for changes polling cannot capture. Do not stop at a happy-path pagination example.

For each resource, establish its provider contract and choose a safe completion boundary before coding. Keep provider payloads raw; application-specific projections are optional and separate. Compare existing registry providers and established implementations such as Brain when accessible, then verify the API contract rather than copying their assumptions. Private repository access is not a dependency of the installed skill.

The release gate is evidence that interruptions resume or safely replay, progress follows destination acknowledgement, empty reads commit completion, and late changes have a reconciliation plan. Full scans are valid when justified by the API; completion checkpoints do not make them change feeds. Reliable full-sync replay does not require a provider-owned scan state machine. Match manifest strategy labels to actual behavior, document limitations and identity/state migrations, and add portable failure/restart fixtures.

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

- TypeScript and direct ClickHouse config are required. Preserve existing schema discovery: add the provider entry to `schema` paths, or re-export its schema and active pipelines from the project `entry`. Migrations create destinations.
- Stream IDs own checkpoints: keep them stable and account-scoped. Pipelines group streams without dependency ordering.
- Use `context.attempt`/`paginate`, forward cancellation, and throw `HttpError.fromResponse` for HTTP failures. Yield bounded chunks.
- Support historical bounds or state explicitly that a full-sync reader ignores them and does not provide date-range backfills. When supported, enforce both bounds and freeze unfinished selections across restarts. Persist complete validated resume state; the executor commits it after writes.
- Separate the completed watermark from unfinished traversal state. Newest-first pages cannot alone advance a completed timestamp watermark; documented fixed-window timestamp frontiers or scoped page positions can still resume unfinished reads. Preserve timestamp precision and equal-timestamp coverage.
- Choose overlap from indexing/arrival behavior. For children that appear or change without updating their parent, retain bounded pending parents or reconcile old roots; a recent overlap alone is insufficient.
- Custom tables need `ingestionColumns`. Prefer `simpleLoader`; custom loaders must preserve write identity and acknowledge publication before returning receipts.
- Delivery is at-least-once: choose reconciliation keys/versioning. Leave explicit chunk `id` unset for mutable observations. A stable page, cursor, or window label is insufficient: explicit data-bearing IDs require replay-immutable content. State-only markers can flush progress.
- Fetch deletion signals explicitly and retain raw cancellation/tombstone payloads. Full sync does not reconcile missing IDs; never infer deletions from partial or inaccessible scans. Complete required child reads before publishing a complete embedded document, or use independent raw child streams/durable pending work that gates completion.
- Use an external scheduler and run one process per project/target, including backfills.

## Deliver and verify

For integrations published in the official app registry, include the provider's official logo for the documentation listing. Store the asset in `apps/docs/public/logos/<provider>.svg` (or another supported image format), record its official source in `apps/docs/public/logos/README.md`, and set `meta.chkit.logo` to `https://chkit.obsessiondb.com/logos/<provider>.svg`. Use the provider's artwork without redrawing or altering it. The docs build requires the logo URL and a matching local asset. Read `apps/docs/src/content/docs/api-sync/registry-authoring.md` for registry metadata, integration guides, and immutable release publication.

Keep one draft version artifact per integration per unmerged PR. Releases already present in the merged base are immutable; committed PR drafts remain editable. Consolidate later edits into the draft's current `meta.chkit.changelog` entry and regenerate that same version with `bun run registry:release -- --base origin/main <provider>`; validate with `bun run check:registry-releases -- --base origin/main`. Use the actual PR base if different. A version bump follows a previously merged release, not each coding iteration.

Deliver definitions, config, and run/query commands. Inspect exports with `chkit ingest list`; generate and review migrations, then use `chkit check` against the configured development target after applying them. `check` has no `--offline` flag. Test checkpoint behavior through `runIngestion` and memory adapters, not just reader iteration; use the applicable recovery cases in the stable-sync reference for registry sources. Keep live writes within authorization. Report verified behavior and limitations.
