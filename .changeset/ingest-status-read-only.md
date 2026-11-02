---
"@chkit/plugin-ingest": patch
"@chkit/clickhouse": patch
---

`chkit ingest status` only reads, so read-only users can run it. It no longer creates the journal table: when the journal (or the database) does not exist, every selected stream reports `v0 (no checkpoint)`. A `readonly = 1` user reads the journal without settings, which it cannot change. Native executors expose the `readonly` lookup they already make as an optional `canChangeSettings()`.
