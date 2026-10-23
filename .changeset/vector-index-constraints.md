---
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"chkit": patch
---

Support `vector_similarity` skip indexes (`method`, `distanceFunction`, optional
`dimensions` and HNSW tuning, validated against the ClickHouse rules) and table
`constraints` (`CHECK` / `ASSUME`) in schemas, migrations, pull and drift.
Constraint changes plan `ADD CONSTRAINT` / `DROP CONSTRAINT` (risk `caution`,
with a warning), get `ON CLUSTER`, and wait on every replica. Any other index
type is expressible as `type: 'raw'`, and pull now keeps an index it cannot
express structurally as a raw index instead of rewriting it (an unknown type
used to come back as `set`). Drops of skip indexes, constraints and projections
run before the column ALTERs, so dropping a column together with the index or
constraint that reads it no longer fails. Drift reports `constraint_mismatch`
and a `constraintDiffs` list.
