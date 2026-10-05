# Linear raw ingestion example

This is a small editable starting point based on the Linear source in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync). It stores provider responses as native JSON without Brain's memory or sales projections.

Set `LINEAR_API_KEY` in the runtime environment and configure a direct ClickHouse connection. Edit the GraphQL `query` and raw table declaration in `sources/issues.ts` to request fields and configure the destination. Native JSON requires ClickHouse 25.3 or later.

`config.ts` supplies the source identity, initial timestamp and overlap. `pipeline.ts` groups the issues stream in one installation pipeline; add other supported resource types as independent streams. `createLinearPipeline(config, deps)` binds that configuration and an injectable `fetch`/token reader. Its default pipeline and stream IDs remain `linear` and `linear.issues`. Destination schemas stay in the module exports rather than runtime configuration.

Keep each stream ID and destination tied to one Linear workspace. The reader does not resolve the authenticated workspace identity: when changing the token to another workspace, use a new stream ID and destination before ingesting so the old watermark cannot skip that workspace's history. Adding requested fields later requires a historical reconciliation to populate older observations.

```sh
bunx chkit check
bunx chkit generate --name add_linear
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:linear
```

## Resources

- `issues` → `linear_issues_raw`

## Sync and recovery

Issues use a bounded `updatedAt` filter and `orderBy: updatedAt`, with `includeArchived: true`. The initial window starts at the Unix epoch; later windows replay five minutes before the committed watermark. Relay issue cursors and comment cursors are used only during the current read. `paginate` owns request retries and continuation cycle detection; the resource reader validates provider connections and completes all accessible comments before publishing their parent observation, retaining the provider's connection shape and the final `pageInfo`.

Newest-first pages do not define a safe timestamp frontier. The checkpoint advances to the fixed execution cutoff only after the whole window and all destination writes succeed, including an empty successful window. A source or sink failure replays the window from its lower bound. Mutable observations have no declared chunk ID, so changed provider fields remain eligible for insertion on replay.

Deleted issues remain stored. Archived issues are retained explicitly. A comment-only change is not assumed to advance the parent issue's `updatedAt`, and cursor pagination is not a guaranteed source snapshot. Schedule periodic reconciliation with a new backfill ID to refresh old discussions, or add a durable webhook companion:

```sh
bunx chkit ingest run --tag provider:linear --backfill reconcile-2026-10-04 --from 1970-01-01
bunx chkit ingest status --tag provider:linear --json
```

Reconciliation reads current issue observations by their last-update timestamp; it does not reconstruct historical issue versions. Run one ingestion process per ClickHouse target at a time.

## Fixture tests

```sh
bunx chkit add linear --with-tests
bun test src/integrations/linear/tests/basic.test.ts
```

The portable suite covers configuration binding, isolated installation checkpoints, bounded archive-inclusive queries, complete comments, continuation validation, failure replay, request retries, sink ordering and empty-window checkpoints without live credentials.
