---
"@chkit/plugin-ingest": patch
---

Validate checkpoint strategy identities when a selected stream runs, before planning or reading: IDs must be non-empty strings and versions must be safe integers of at least 1. Previously a stream could report success while every later run restarted because the journal rejected its envelope. Definition construction remains lazy. Report invalid timestamp-window bounds clearly, including callbacks returning non-Date values, without rejecting Dates from another realm or equal bounds.

Clarify strategy-owned backfill validation, local-time date-times versus UTC date-only flags, and the clock-skew and chunk-budget cases that prevent timestamp progress. Document manual replicated-journal provisioning and the need to retain checkpoint ancestry when managing journal partitions.
