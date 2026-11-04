---
"@chkit/plugin-ingest": patch
"@chkit/clickhouse": patch
---

Ingestion loading keeps rows and values intact in more cases:

- Invalid `maxRowsPerInsert` values are rejected instead of hanging or silently dropping rows, and replaying a batch with a different insert size can no longer skip unsaved rows.
- DateTime and DateTime64 columns accept ISO timestamps and `Date` objects, and JSONEachRow keeps non-finite floats and `Map`s; a non-finite number aimed at a non-float column now fails or lands as text instead of becoming zero or null.
- Missing declared ingestion metadata and unflattened Nested inputs are rejected.
- In native JSON columns, space-separated timestamp strings that used to be inferred as DateTime now stay String, so a path can hold both types across older and newer rows.
- Upgrade: batch hashes and deduplication tokens changed, so an interrupted run replayed across the upgrade can insert duplicates once; do not recover one run with both old and new loaders.
