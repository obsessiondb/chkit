---
"@chkit/plugin-backfill": patch
---

`chkit plugin backfill resume` no longer submits a chunk again unless the server shows its last attempt failed: when the outcome is unknown (no row in `system.query_log`, lost contact while polling, or a replica the user may not read), it stops and names the chunk and its query id, and the new `--accept-unknown` flag replays those chunks.
