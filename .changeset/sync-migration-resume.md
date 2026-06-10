---
"chkit": patch
---

Resume partially-applied synchronous (DDL) migrations instead of replaying from the first statement. Previously, if a multi-statement migration failed partway (e.g. statement 1 added a column, statement 2 failed), nothing was journaled and re-running replayed statement 1 — which then failed with "column already exists", leaving the migration permanently stuck with the database mutated. Sync statements now record per-statement journal state (`started` → `completed`/`failed`), mirroring the async path: completed statements are skipped on re-run so the migration resumes from where it failed. Resuming across a migration-file edit is refused (checksum guard).
