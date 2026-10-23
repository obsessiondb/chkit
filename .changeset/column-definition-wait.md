---
"chkit": patch
"@chkit/clickhouse": patch
"@chkit/core": patch
---

`migrate` now waits for a changed column's definition, not only its presence, before the next statement (#290). After `ADD COLUMN` and `MODIFY COLUMN` it waits until every replica reports the same type, default, comment and codec in `system.columns`, and after `MODIFY COLUMN` also until they show what the statement sets: the default kind, the default expression (formatted by the server with `formatQuerySingleLine`, so ClickHouse's rewriting of expressions is not a mismatch), the comment, and a removed default or codec. `RENAME COLUMN` waits until no replica lists the old name and every replica lists the new one, and `ADD INDEX`/`DROP INDEX` wait for the index on every replica instead of only the table. A timeout names the replica and field that still differ, and says when every replica agrees on the old value (the server accepted the statement without applying it, as ObsessionDB does for `MODIFY COLUMN ... EPHEMERAL <default>`, #285). `waitForDDLPropagation` takes the executed statement as `options.statement`, and `@chkit/core` exports its SQL lexer.
