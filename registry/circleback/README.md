# Circleback raw ingestion example

This is a small editable starting point based on the Circleback source in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync). It stores provider responses as native JSON without Brain's memory or sales projections.

Set `CIRCLEBACK_API_KEY` in the runtime environment and configure a direct ClickHouse connection. Edit the reader in `index.ts` to select meetings and decide whether to fetch transcripts. Native JSON requires ClickHouse 25.3 or later.

```sh
bunx chkit check
bunx chkit generate --name add_circleback
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:circleback
```

## Resources

- `meetings` → `circleback_meetings_raw`

The meetings endpoint is scanned on every run. Missing transcripts remain null; removed meetings remain stored. A failed API request fails the stream. Raw rows use provider IDs and keep the last observed value; there is no deletion reconciliation. Edit the readers, select fewer streams, or add SQL views for a specific use case. Run one ingestion process per ClickHouse target at a time.
