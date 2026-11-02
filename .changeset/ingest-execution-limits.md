---
"@chkit/plugin-ingest": patch
---

A custom iterator whose `return()` throws synchronously no longer replaces the stream's outcome. Source services expire with their reader, including retained `fetch`/`attempt` functions and nested calls from unfinished operations. Large `Retry-After` delays in the pipeline request queue no longer overflow the timer into repeated one-millisecond waits and warnings. Document that foreign operations which ignore cancellation retain their physical concurrency permits until they settle.
