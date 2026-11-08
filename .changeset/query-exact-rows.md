---
"@chkit/core": patch
---

Query rows now return 64-bit and wider integers that a JS number would round as strings of their exact digits, with no ClickHouse setting needed.
