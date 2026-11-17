Text index SQL in generated migrations, snapshots and `chkit pull` output keeps the space
between a keyword and `(` (`a OR (b)`, `NOT (x)`), as ClickHouse writes it, instead of
`OR(` (#586, fixed in TS too). Existing indexes and snapshots plan no migration.
