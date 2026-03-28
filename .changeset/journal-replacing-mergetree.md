---
"chkit": patch
"@chkit/plugin-codegen": patch
---

Use ReplacingMergeTree(applied_at) instead of MergeTree() for the _chkit_migrations journal table. This ensures the FINAL keyword works correctly on ClickHouse Cloud, where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
