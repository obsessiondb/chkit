---
"@chkit/plugin-ingest": patch
---

A `read()` that returns something other than an async iterable now fails the stream with a configuration error instead of being retried under the stream policy. A custom iterator whose `return()` throws synchronously no longer replaces the stream's outcome. Source request capabilities expire with their reader attempt, and cancellation is rechecked after asynchronous retry callbacks so no new request or retry fact starts after that point. Large `Retry-After` delays no longer overflow the timer and retry immediately when `maxRetryTime` allows the wait. Document that foreign operations which ignore cancellation retain their physical concurrency permits until they settle.
