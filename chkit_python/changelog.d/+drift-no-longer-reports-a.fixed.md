`drift` no longer reports a column as changed when its default wraps a heredoc that holds a
parenthesis, such as `($$a)$$)`, which ClickHouse stores as `'a)'`: parentheses inside a
heredoc or a comment no longer count as structure (#587, fixed in TS too).
