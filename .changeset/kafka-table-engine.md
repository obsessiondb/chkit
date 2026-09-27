---
"@chkit/core": minor
"@chkit/clickhouse": patch
"@chkit/plugin-pull": minor
"chkit": minor
---

Support Kafka engine tables without MergeTree key clauses, with escaped literal
settings, pull round trips, and normalized drift/check comparisons. Preserve the
existing setting-string contract for other engines. Reject unsupported Kafka
changes before writing migration artifacts and document an explicit, destructive-
gated replacement workflow. Handle quoted delimiters and escaped trailing
backslashes in introspection and migration statement splitting.
