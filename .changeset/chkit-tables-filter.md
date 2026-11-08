---
"chkit": patch
---

`drift`, `check` and `pull` no longer skip tables such as `xchkit_events`; only names that start with `_chkit_` are skipped (#490).
