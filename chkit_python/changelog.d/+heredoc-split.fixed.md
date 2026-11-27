`migrate` splits SQL correctly around ClickHouse line comments, nested block comments, heredocs and escaped quoted names, preserving semicolons and comment markers inside literals.

- Breaking: a partly applied migration split differently by an earlier release stops with `statement_split_changed` rather than resuming at the wrong statement.

Plugin `on_before_apply` hooks and statement errors receive SQL without header or marker comments, with the statement terminator preserved.
