---
"@chkit/plugin-ingest": patch
---

A rate-limit hint too far in the future for a `Date` no longer fails the stream with "Invalid time value"; ingestion waits it out like any other long hint.
