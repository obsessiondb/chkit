---
"chkit": patch
---

`migrate` no longer asks for `--allow-destructive` for a `DROP`/`TRUNCATE` inside a `//`, `#` or `/* */` comment, a string or a quoted name, and now does ask for one when a comment sits between the keywords, as in `DROP /* x */ TABLE t`, which used to run unflagged.
