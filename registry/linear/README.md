# Linear raw ingestion example

This is a small editable starting point based on the Linear source in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync). It stores provider responses as native JSON without Brain's memory or sales projections.

Set `LINEAR_API_KEY` in the runtime environment and configure a direct ClickHouse connection. Edit the GraphQL `query` in `index.ts` to request the issue fields needed by the project. Native JSON requires ClickHouse 25.3 or later.

```sh
bunx chkit check
bunx chkit generate --name add_linear
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:linear
```

## Resources

- `issues` → `linear_issues_raw`

Every run reads all accessible issues. The example requests the first 100 comments per issue; extend the query for complete discussions. A failed API request fails the stream. Raw rows use provider IDs and keep the last observed value; there is no deletion reconciliation. Edit the readers, select fewer streams, or add SQL views for a specific use case. Run one ingestion process per ClickHouse target at a time.
