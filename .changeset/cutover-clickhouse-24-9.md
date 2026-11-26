---
"chkit": patch
"@chkit/core": patch
---

Zero-downtime cutovers now require ClickHouse 24.9 or later on every replica. The first migration statement rejects older servers before creating any cutover objects.
