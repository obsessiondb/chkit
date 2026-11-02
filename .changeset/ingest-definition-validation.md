---
"@chkit/plugin-ingest": patch
---

Validate ingestion definitions and host limits before a run. Non-string ids, destinations that are not table definitions, a missing `read` function, non-array or empty tags, non-stream pipeline members, non-integer `budget` and concurrency ceilings, and malformed `retry` numbers in `defineStream` and `definePipeline` are configuration errors when an ingest command selects the pipeline, instead of failing the first scheduled run. Declared tags may no longer start with `stream:` or `pipeline:`, which are derived from ids, so `--tag stream:<id>` always selects exactly that stream.

Execution budgets above 2147483 seconds (`--max-duration`, `maxDurationSeconds`) or 2147483647 milliseconds (`maxDurationMs`), `Infinity` and `NaN` are rejected as configuration errors: the timer previously clamped them to one millisecond and the run ended as `budget_exhausted` before the first fetch. `runIngestion` also rejects a `prefetchBatches` value that is not a positive integer.

`paginate` reports a `fetchPage` result that is not a page object with an `items` array, and a continuation that cannot be JSON-serialized, as a configuration error instead of a `TypeError`. Omitted continuations remain accepted as terminal pages.
