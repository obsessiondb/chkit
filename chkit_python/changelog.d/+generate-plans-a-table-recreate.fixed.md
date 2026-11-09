`generate` plans a table recreate, and `drift` reports `order_by_mismatch` /
`primary_key_mismatch`, when a key moves between columns `a` and `b` and one column named
`a, b` (or between `a b` and `ab`); both read the key as unchanged (#558, fixed in TS too).
