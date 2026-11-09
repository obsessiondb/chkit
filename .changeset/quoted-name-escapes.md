---
"chkit": patch
---

`chkit generate` reads a quoted name or string in schema SQL as ClickHouse does (`` `events\x5fraw` `` is `events_raw`, `` `raw\q` `` keeps its backslash), so a view that reads another view through such a name is created after it; before, every escape lost its backslash and the migration could fail.
