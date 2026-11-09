---
"chkit": patch
---

`chkit init --connect` and `create-chkit --connect` reject a value other than `claim`, `account`, `clickhouse` or `later` with exit code 1 before writing any file, instead of starting ObsessionDB signup.
