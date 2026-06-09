---
"chkit": patch
---

Scan the executable SQL of pending migrations for destructive statements, not just planner-emitted safety markers. A hand-written or hand-edited migration containing `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DROP VIEW`/`DROP MATERIALIZED VIEW`, `DETACH`, or `DROP DATABASE` — with no `-- operation: risk=danger` comment — was previously applied silently in non-interactive/CI runs, causing irreversible data loss. These statements now require `--allow-destructive` (or `safety.allowDestructive`) like any other destructive operation. Commented-out statements are ignored (comments are stripped before scanning).
