---
"chkit": patch
---

`migrate` no longer cuts a statement at a `;` or strips a `--` inside a `$$ … $$` heredoc, a nested `/* */` comment or a quoted name with a backslash-escaped backtick, and a quote or `$` inside a `//` or `#` comment no longer changes where statements end.
