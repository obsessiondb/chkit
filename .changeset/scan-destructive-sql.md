---
"chkit": patch
---

Scan the executable SQL of migrations for hand-written destructive statements, not just planner-emitted safety markers. A destructive statement (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DROP VIEW`/`DROP MATERIALIZED VIEW`, `DETACH`, or `DROP DATABASE`) with no `-- operation:` marker — whether the whole migration was hand-written or the statement was hand-appended to a generated one — was previously applied silently in non-interactive/CI runs, causing irreversible data loss. Such statements now require `--allow-destructive` (or `safety.allowDestructive`) like any other destructive operation. Planner-marked statements keep their existing risk classification (generated migrations emit one marker per statement), so a planner-approved non-danger operation such as a materialized-view recreate is not blocked. Commented-out statements are ignored (comments are stripped before scanning).
