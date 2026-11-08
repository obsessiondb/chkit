---
"@chkit/plugin-ingest": patch
---

Ingestion no longer silently drops row fields the destination has no column for: they land in a `_chkit_rest` JSON column when the table declares one, and the run logs their names.

- Breaking: without `_chkit_rest`, a yielded field with no column fails the stream; map it to a column or declare `_chkit_rest`.
