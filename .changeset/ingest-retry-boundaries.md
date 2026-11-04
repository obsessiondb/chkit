---
"@chkit/plugin-ingest": patch
---

Ingestion retries only transient failures, at the request:

- Network errors, timeouts and HTTP 408, 425, 429 and 5xx are retried; any other failure fails the stream at once, and the next run resumes from the last checkpoint instead of restarting the stream within the run.
- Readers get `context.fetch`, which shares the pipeline's request queue (a `Retry-After` pauses every request of the pipeline), retries transient failures, aborts after 30 seconds and throws `HttpError` for unsuccessful responses.
- `HttpError.withStatus(response, status, { retryAfterMs })` marks a failure the classification cannot see, such as a rate limit reported as 403.
- An invalid ingestion definition no longer breaks `generate` or `migrate`; it is reported when an ingest command selects the pipeline and by `chkit check` as `ingest_invalid_pipeline`.
- `@chkit/plugin-ingest/testing` adds `createSourceContext` and `createReadContext` for testing a client or reader directly.
- Breaking: `classifyError` is removed; map rate limits with `HttpError.withStatus`.
- Breaking: `FetchContext` is now `SourceContext`, `context.attempt` rejects with the original error, and `retry` moved to `runIngestion` without `shouldRetry`, `shouldConsumeRetry` or `factor`.
- Breaking: `FetchFailure`, `IngestConfigError`, `ErrorClassifier` and `FailureClass` are no longer exported.
