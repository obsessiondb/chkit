# Google Meet raw ingestion example

This is a small editable starting point based on the Google-Meet source in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync). It stores provider responses as native JSON without Brain's memory or sales projections.

Set `GOOGLE_MEET_ACCESS_TOKEN` in the runtime environment and configure a direct ClickHouse connection. Edit `lookbackDays` in `index.ts` to select the conference window. Native JSON requires ClickHouse 25.3 or later.

```sh
bunx chkit check
bunx chkit generate --name add_google_meet
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:google-meet
```

## Resources

- `conferences` → `google_meet_conferences_raw`
- `transcripts` → `google_meet_transcripts_raw`

Each run reads a configured time range. Transcripts generated later require another scan of that range. A failed API request fails the stream. Raw rows use provider IDs and keep the last observed value; there is no deletion reconciliation. Edit the readers, select fewer streams, or add SQL views for a specific use case. Run one ingestion process per ClickHouse target at a time.
