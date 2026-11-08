---
"chkit": patch
---

Async `migrate` statements no longer fail on a fresh ClickHouse server that has not created `system.query_log` yet.
