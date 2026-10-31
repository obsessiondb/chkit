---
"@chkit/plugin-ingest": patch
---

Validate ingestion definitions and host limits eagerly. `defineStream` and `definePipeline` now reject non-string ids, destinations that are not table definitions, a missing `read` function, non-array or empty tags, non-stream pipeline members, non-integer `budget` and concurrency ceilings, and malformed `retry` numbers with `IngestConfigError` instead of failing the first scheduled run. Declared tags may no longer start with `stream:` or `pipeline:`, which are derived from ids, so `--tag stream:<id>` always selects exactly that stream.

Execution budgets above 2147483 seconds (`--max-duration`, `maxDurationSeconds`, `maxDurationMs`), `Infinity` and `NaN` are rejected as configuration errors: the timer previously clamped them to one millisecond and the run ended as `budget_exhausted` before the first fetch. `runIngestion` also rejects a `prefetchBatches` value that is not a positive integer.

`paginate` reports a `fetchPage` result that is not a `{ items, next }` page, and a continuation that cannot be JSON-serialized, as `IngestConfigError` instead of a `TypeError`.
