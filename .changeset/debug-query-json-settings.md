---
"chkit": patch
---

With `CHKIT_DEBUG=1`, `queryJson` calls now pass their ClickHouse settings through to the server. Before, debug mode dropped them, so a call could behave differently with debugging on.
