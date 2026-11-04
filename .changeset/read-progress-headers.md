---
"@chkit/clickhouse": patch
"chkit": patch
---

Statements running longer than about 10 seconds no longer fail with `HPE_HEADER_OVERFLOW`, and long reads keep their connection open through a proxy with an idle timeout, except for `readonly = 1` users.
