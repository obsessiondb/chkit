---
"@chkit/plugin-ingest": patch
---

Invalid ingestion definitions and host limits, such as a missing `read` or a non-integer or out-of-range budget, are reported as configuration errors instead of failing the first run or ending it before the first fetch.

Breaking: declared tags may no longer start with `stream:` or `pipeline:`.
