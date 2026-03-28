---
"@chkit/clickhouse": patch
"@chkit/plugin-backfill": patch
---

Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
