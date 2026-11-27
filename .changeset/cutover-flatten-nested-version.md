---
"chkit": patch
---

`generate --cutover` now refuses ClickHouse versions older than 25.1 at the first statement when it creates tables with an explicit `flatten_nested` setting from the schema.
