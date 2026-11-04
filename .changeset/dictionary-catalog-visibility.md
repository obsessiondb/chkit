---
"chkit": patch
"@chkit/clickhouse": patch
---

`migrate` no longer times out after `CREATE OR REPLACE DICTIONARY` while the dictionary reloads; it waits for the dictionary in every replica's catalog instead.
