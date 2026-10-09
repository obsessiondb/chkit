---
"@chkit/core": patch
---

`MATERIALIZED` and `ALIAS` columns with a plain string default now fail validation with `column_expression_requires_fn` instead of storing the text. `ALIAS` or `EPHEMERAL` columns named directly in keys, `partitionBy` or engine arguments report `column_kind_not_stored`; `EPHEMERAL` columns in skip indexes or projections, and codecs on `ALIAS` or bare `EPHEMERAL` columns, are also rejected. Removing a column expression now runs `REMOVE` as its own operation before `MODIFY COLUMN`, so a type change whose old default cannot be cast (for example `String DEFAULT 'abc'` to `UInt64`) migrates successfully.
