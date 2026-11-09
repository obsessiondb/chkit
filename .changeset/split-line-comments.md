---
"chkit": patch
---

`migrate` reads `//`, `# ` and `#!` comments as ClickHouse does, so a `;` inside one no longer runs the commented-out text after it as a statement, and a quote or `/*` inside one no longer joins statements (#562). A partly applied migration whose recorded statements another release split differently stops with `statement_split_changed` instead of resuming at the wrong statement.
