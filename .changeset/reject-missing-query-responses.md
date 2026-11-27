---
"@chkit/clickhouse": patch
---

Migration journal and query-status reads reject missing or truncated responses instead of treating recorded work as absent, while valid empty results still succeed.
