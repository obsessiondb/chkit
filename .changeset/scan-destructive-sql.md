---
"chkit": patch
---

Scan the executable SQL of fully hand-written migrations for destructive statements, not just planner-emitted safety markers. A hand-written migration containing `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DROP VIEW`/`DROP MATERIALIZED VIEW`, `DETACH`, or `DROP DATABASE` — with no `-- operation:` markers — was previously applied silently in non-interactive/CI runs, causing irreversible data loss. These statements now require `--allow-destructive` (or `safety.allowDestructive`) like any other destructive operation. Generated migrations (which always carry planner `-- operation:` markers) keep their existing risk classification — the raw SQL scan only applies to marker-less migrations, so a planner-approved non-danger operation such as a materialized-view recreate is not blocked. Commented-out statements are ignored (comments are stripped before scanning).
