---
"@chkit/plugin-ingest": patch
---

Configure execution-wide source retries with `ingest({ retry: { retries: 2 } })` or override the retry count for one run with `chkit ingest run --retries 2`; the default remains 5.
