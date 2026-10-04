# Lemlist raw ingestion example

This is a small editable starting point based on the Lemlist source in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync). It stores provider responses as native JSON without Brain's memory or sales projections.

Set `LEMLIST_API_KEY` in the runtime environment and configure a direct ClickHouse connection. Edit `pageSize` and the stream list in `index.ts` for the resources needed by the project. Native JSON requires ClickHouse 25.3 or later.

```sh
bunx chkit check
bunx chkit generate --name add_lemlist
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:lemlist
```

## Resources

- `activities` → `lemlist_activities_raw`
- `campaigns` → `lemlist_campaigns_raw`

Both streams scan all accessible pages each run. Removed campaigns or activity records remain stored. A failed API request fails the stream. Raw rows use provider IDs and keep the last observed value; there is no deletion reconciliation. Edit the readers, select fewer streams, or add SQL views for a specific use case. Run one ingestion process per ClickHouse target at a time.
