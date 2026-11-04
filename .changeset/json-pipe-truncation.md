---
"chkit": patch
---

`--json` output over 64 KiB is no longer cut off when piped to a slow reader such as `jq`.
