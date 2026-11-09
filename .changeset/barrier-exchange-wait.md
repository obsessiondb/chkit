---
"chkit": patch
---

`migrate` waits for every replica after an `EXCHANGE TABLES` even when its `exchange_tables` statement is marked `mode=barrier`, as chkit-py does, before it runs the next statement.
