A quoted name or string in schema SQL reads as ClickHouse reads it, as in TS (#639):
`` `events\x5fraw` `` is `events_raw` and `` `raw\q` `` keeps its backslash. Before, every
escape lost its backslash, so `generate` could miss that a view reads another view and
create it first, which failed the migration.
