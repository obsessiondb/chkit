---
"chkit": patch
---

Document Slack's three raw resources and verify messages-first ingestion and metadata execution that leaves message progress unchanged. Default message bootstrap and overlap to 24 hours, with optional explicit historical bootstrap and isolated backfills. Complete each history page's replies before checkpointing its timestamp frontier; interruptions replay the unfinished page instead of retaining thread queues. Remove automatic historical reconciliation: edits and late replies on roots outside the chosen window are excluded. Replies remain individual native messages joined through thread references in ClickHouse.
