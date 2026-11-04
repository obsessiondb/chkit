---
"@chkit/plugin-ingest": patch
---

A reader's retained `context.fetch` and `context.attempt` now reject once the reader ends, a custom iterator whose `return()` throws no longer replaces the stream's outcome, and a large `Retry-After` no longer causes repeated one-millisecond waits and warnings.
