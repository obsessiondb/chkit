---
"@chkit/plugin-ingest": patch
---

Retry only transient ingestion failures, each in exactly one layer.

- Network error codes (also inside an error's `cause` chain), timeouts, and `HttpError` 408/425/429/5xx are retried. Any other failure now fails the stream at once, wherever it is thrown, instead of being retried up to the policy budget. A Node `fetch failed` without a network code, such as a refused redirect, is no longer treated as transient.
- Only requests are retried. A failure anywhere else in a reader, its strategy, or checkpoint parsing fails the stream, and the next run resumes from the last committed state; streams are no longer restarted within a run. An insert that fails its 3 attempts therefore no longer triggers up to 5 reader restarts.
- `context.attempt` rejects with exactly the thrown value instead of a `FetchFailure` wrapper. `FetchContext` is replaced by `SourceContext`, which adds `fetch`.
- New `HttpError.withStatus(response, status, { retryAfterMs })` for a failure the classification cannot see, such as a rate limit reported as 403, inside a successful response, or with its wait in a provider reset header; it keeps the URL and headers, and `Retry-After` wins over `retryAfterMs`.
- `defineStream`, `definePipeline`, and `timestampWindow` no longer throw on import, so `generate` and `migrate` work while an ingestion definition is invalid. The error surfaces when an ingest command selects the pipeline (exit `2`) and as an `ingest_invalid_pipeline` finding in `chkit check`. Stream failures caused by zod errors are listed by path.
- New `context.fetch` for readers: it goes through the pipeline's request queue, retries transient failures, aborts on cancellation or after 30 seconds, and throws `HttpError` for unsuccessful responses. `runIngestion` accepts a `fetch` to answer those requests in tests. An attempt started inside another attempt, such as a `context.fetch` in a `paginate` page, runs within the outer attempt and its retries instead of waiting for a second queue slot.
- `@chkit/plugin-ingest/testing` adds `createSourceContext` and `createReadContext`, which handle requests like `context.fetch` does in a run, for testing a client or reader directly.
- Requests of one pipeline share a request queue: a rate-limited response with `Retry-After` pauses every request of that pipeline until then, and a rate-limit retry the provider schedules at least `minTimeout` ahead no longer counts against `retries`.
- `timestampWindow` checks its options when the stream plans its run, and definitions are checked where they are selected, so spreading a definition can no longer drop its error.
- `chkit ingest run` prints each distinct stream error once, with the streams it affected, instead of repeating it per stream. `--json` output is unchanged.
- Retries need no configuration. `retry` moved from `defineStream` and `definePipeline` to `runIngestion`, for hosts and tests; the `shouldRetry` and `shouldConsumeRetry` callbacks and the `factor` option are removed.
- `classifyError` is removed. A provider client maps what the classification cannot see with `HttpError.withStatus(response, 429, { retryAfterMs })` inside the request's attempt.
- `IngestConfigError`, `FetchFailure`, `ErrorClassifier`, and `FailureClass` are no longer exported; readers throw any error type.
