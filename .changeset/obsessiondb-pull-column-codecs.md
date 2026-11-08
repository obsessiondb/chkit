---
"@chkit/plugin-obsessiondb": patch
---

`chkit pull`, `chkit drift` and `chkit check` through the ObsessionDB console API now read column codecs. Before, pull dropped every `CODEC(...)` and drift reported `changed_column` for each column with a codec (#487).
