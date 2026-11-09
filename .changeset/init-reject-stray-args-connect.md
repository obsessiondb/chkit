---
"chkit": patch
---

`chkit init` rejects an argument that is not a flag and a `--connect` value other than `claim`, `account`, `clickhouse` or `later`, with exit code 1 and before writing anything, as chkit-py does; a mistyped `--connect` no longer starts ObsessionDB signup.
