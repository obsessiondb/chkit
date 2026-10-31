---
"@chkit/plugin-ingest": patch
"@chkit/clickhouse": patch
---

Harden ingestion loading: reject invalid `maxRowsPerInsert` values before they can hang or silently discard rows, identify physical INSERTs by their row ranges so resizing a replay cannot suppress unsaved rows, hash and encode rows individually, and stream native INSERT encoding instead of joining wide batches into one string.

Accept ISO timestamps and Date objects in DateTime/DateTime64 columns with best-effort parsing, preserve non-finite floats and JavaScript Maps in JSONEachRow, reject missing declared ingestion metadata and unflattened Nested inputs, and stop retrying deterministic ClickHouse parse/type/column errors. Unknown-table, capacity, network and replica errors remain retryable. Unknown-field handling otherwise remains unchanged. Non-finite numbers aimed at non-float columns now fail or land as text rather than becoming zero or null; Date/Date32 still require date-only strings.

Batch hashes and write-unit tokens change in this release. A failed run replayed across the upgrade can insert duplicates once instead of reusing its old deduplication tokens; delivery remains at-least-once. Use destination keys/versioning and `FINAL` where appropriate to reconcile repeats. Do not mix old and new loaders while recovering the same interrupted run.

Timestamp inference is disabled for native JSON paths (`input_format_try_infer_datetimes=0`) so the new best-effort parser does not reinterpret raw ISO timestamp strings. Space-separated raw timestamps previously inferred as DateTime now remain String; paths can hold mixed types across older and newer rows. Explicitly typed DateTime/DateTime64 columns still use best-effort parsing.
