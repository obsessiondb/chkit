---
"@chkit/core": patch
---

`view({ comment })` and `materializedView({ comment })` now reach ClickHouse: the generated `CREATE VIEW` / `CREATE MATERIALIZED VIEW` carries `COMMENT '...'` (before `AS`, where ClickHouse stores it), so `system.tables.comment` is set. Before, the comment was dropped, and a comment change recreated the view still without it (#406).
