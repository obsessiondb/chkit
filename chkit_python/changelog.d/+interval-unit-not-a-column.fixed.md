`generate` no longer reads the unit of `INTERVAL 1 day` or `EXTRACT(day FROM ts)` as a column named `day`, so it no longer reorders column statements around a column with that name.
