# Google Calendar raw ingestion example

This is a small editable starting point based on the Google-Calendar source in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync). It stores provider responses as native JSON without Brain's memory or sales projections.

Set `GOOGLE_CALENDAR_ACCESS_TOKEN` in the runtime environment and configure a direct ClickHouse connection. Edit `calendarId`, `pastDays`, and `futureDays` in `index.ts` before the first migration. Native JSON requires ClickHouse 25.3 or later.

```sh
bunx chkit check
bunx chkit generate --name add_google_calendar
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:google-calendar
```

## Resources

- `events` → `google_calendar_events_raw`

Each run reads a configured time range. Events outside the range and deleted records are not reconciled. A failed API request fails the stream. Raw rows use provider IDs and keep the last observed value; there is no deletion reconciliation. Edit the readers, select fewer streams, or add SQL views for a specific use case. Run one ingestion process per ClickHouse target at a time.
