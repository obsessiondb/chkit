---
"chkit": patch
---

`migrate` no longer cuts a statement at a `;` or strips a `--` inside a `$$ … $$` heredoc, or inside a quoted name with a backslash-escaped backtick.
