---
"@chkit/plugin-ingest": patch
---

Validate checkpoint strategy identities with Zod when a selected stream runs, before planning or reading: IDs must be non-empty strings and versions must be safe integers of at least 1. Previously a stream could report success while every later run restarted because the journal rejected its envelope. Definition construction remains lazy. Validate planned timestamp bounds with Zod's date schema and report invalid values clearly. Equal bounds remain valid; Dates from another JavaScript realm are no longer accepted.

Clarify strategy-owned backfill validation with explicit UTC and timezone-offset examples, and the clock-skew and chunk-budget cases that prevent timestamp progress. Document manual replicated-journal provisioning and the need to retain checkpoint ancestry when managing journal partitions.
