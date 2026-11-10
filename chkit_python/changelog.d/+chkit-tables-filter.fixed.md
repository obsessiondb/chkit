`drift`, `check` and `pull` no longer skip tables such as `xchkit_events` (#490). They
skip only names that start with `_chkit_`. `drift` lists such a table as an extra
object, and `check` counts it. `pull` with no `--database` finds a database that holds
only such tables.
