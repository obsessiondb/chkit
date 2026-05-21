---
"chkit": patch
"@chkit/plugin-obsessiondb": patch
---

Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
