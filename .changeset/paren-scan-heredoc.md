---
"chkit": patch
---

`chkit drift` no longer reports a column as changed when its default wraps a heredoc that holds a parenthesis, such as `($$a)$$)`, which ClickHouse stores as `'a)'`.
