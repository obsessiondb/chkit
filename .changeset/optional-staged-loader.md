---
"@chkit/plugin-ingest": patch
---

Add opt-in stagedLoader for deterministic batch-level, key-based insert-if-absent publication into a single-server MergeTree destination. Preserve simpleLoader as the default and document identity, serialization, recovery and performance tradeoffs.
