---
"create-chkit": patch
---

`create-chkit --connect` rejects a value other than `claim`, `account`, `clickhouse` or `later` before writing any file, as `chkit init --connect` already does.
