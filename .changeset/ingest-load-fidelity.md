---
"@chkit/plugin-ingest": patch
"@chkit/clickhouse": patch
---

Harden ingestion loading: reject invalid `maxRowsPerInsert` values at loader execution before they can hang or silently discard rows, identify direct physical INSERTs by their row ranges so resizing a replay cannot suppress unsaved rows, hash and encode rows individually, and stream direct native INSERT encoding instead of joining wide batches into one string.

Accept ISO timestamps and Date objects in DateTime/DateTime64 columns through the direct destination's best-effort parsing, preserve non-finite floats and JavaScript Maps in JSONEachRow, and reject missing declared ingestion metadata and unflattened Nested inputs. Load retry behavior is unchanged: errors such as a not-yet-visible column can recover within the fixed load budget. Unknown-field handling otherwise remains unchanged. Non-finite numbers aimed at non-float columns now fail or land as text rather than becoming zero or null; Date/Date32 still require date-only strings. The staged loader's publication, deduplication and retry contracts are unchanged.

Batch hashes and write-unit tokens change in this release. A failed run replayed across the upgrade can insert duplicates once instead of reusing its old deduplication tokens; delivery remains at-least-once. Use destination keys/versioning and `FINAL` where appropriate to reconcile repeats. Do not mix old and new loaders while recovering the same interrupted run.

The direct destination disables timestamp inference for native JSON paths (`input_format_try_infer_datetimes=0`) so its best-effort parser does not reinterpret raw ISO timestamp strings. Space-separated raw timestamps previously inferred as DateTime now remain String; paths can hold mixed types across older and newer rows. Explicitly typed DateTime/DateTime64 columns still use best-effort parsing.
