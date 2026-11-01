---
"@chkit/plugin-ingest": patch
---

Fix a crash on Node when a stream yields a chunk above roughly 125,000 rows: the executor spread every row into one `push()` call, which overflowed the call stack with "Maximum call stack size exceeded" as soon as `budget.maxChunkRows` allowed such chunks. Rows are now appended one at a time.
