---
"chkit": patch
---

`generate` orders a column type change after the `MODIFY` or `DROP` of a column, or the TTL change, whose old expression reads the column and whose new one no longer does, and before the `ADD` or `MODIFY` whose new expression starts reading it, so `migrate` no longer fails with code 43 (#814).
