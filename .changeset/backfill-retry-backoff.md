---
"@chkit/plugin-backfill": patch
---

Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
