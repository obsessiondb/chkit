---
"@chkit/clickhouse": patch
"chkit": patch
---

Reads (`chkit query`, `status`, `check`, `drift`, `pull` and journal reads) send progress headers again, so a long read keeps its connection open through a proxy or load balancer with an idle timeout. chkit reads the user's `readonly` level once per connection and sends no settings to a `readonly = 1` user, who cannot change any. Reads and writes now ask for a progress header every 30 seconds instead of every 100 ms: at 100 ms, a query that ran longer than about 10 seconds failed with `HPE_HEADER_OVERFLOW` once the headers passed Node's and Bun's 16 KB limit.
