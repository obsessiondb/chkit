---
"@chkit/plugin-ingest": patch
---

New opt-in `stagedLoader` stages each batch, keeps one row per key and inserts only keys missing from a single-server MergeTree destination; `simpleLoader` remains the default.
