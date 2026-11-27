`drift` and `check` no longer miss a changed expression that starts with a column named `all` or `distinct`, such as an index on `all + id` compared with one on `id`, as in TS.
