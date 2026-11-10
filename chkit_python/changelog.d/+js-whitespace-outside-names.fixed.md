Whitespace outside names is read as TS reads it too (#637): materialized view refresh
intervals, engines, Kafka settings, dictionary `source` / `layout` / `lifetime`, expressions
and types, the clauses `pull` and `drift` read from `SHOW CREATE` and `system` tables,
`--setting`, `--retry` / `--abandon`, `string[]` flag values and backfill options trim and
split on JavaScript whitespace, so a BOM counts as whitespace and `\x1c`-`\x1f` and `\x85`
do not, and both CLIs parse, canonicalize and validate the same input the same way.
