---
"@chkit/plugin-pull": patch
---

`chkit pull` reads refreshable materialized view `DEPENDS ON` names as ClickHouse quotes them: escaped backticks are unescaped, and names containing dots, commas or keywords are kept whole.
