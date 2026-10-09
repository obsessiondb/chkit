---
"@chkit/plugin-ingest": patch
---

Support overlapping ingestion processes with run-scoped journal event identities and validated checkpoint lineage stored entirely in ClickHouse. Stale reads and lost acknowledgements safely replay work without reallocating another run's event identities. Retain valid acknowledged progress when a run has malformed trailing evidence.

Add read-only `ingest doctor` and fingerprint-reviewed `ingest repair`. Recovery preserves a verified full archive and materializes a replacement journal without changing the active configuration. Stop writers, review the snapshot, and explicitly configure the returned journal table before restarting; other namespaces remain intact.
