---
"chkit": patch
---

`drift`, `check` and `pull` no longer skip tables such as `xchkit_events`; they skip only names that start with `_chkit_`. `drift` lists such a table as an extra object, `check` counts it, and `pull` with no `--database` finds a database that holds only such tables (#490).
