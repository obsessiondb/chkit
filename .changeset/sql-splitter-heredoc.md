---
"chkit": patch
---

`migrate` splits statements and detects destructive SQL correctly around ClickHouse comments, heredocs and quoted names, preserving literal semicolons and requiring `--allow-destructive` for commented keyword sequences that still execute. `generate` preserves heredoc expressions and quoted-name escapes, strips engine comments safely, and SQL scanning stays linear for repeated unclosed heredoc openers.

- Breaking: a partly applied migration split differently by an earlier release stops with `statement_split_changed` rather than resuming at the wrong statement.
