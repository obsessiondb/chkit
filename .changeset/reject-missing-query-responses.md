---
"@chkit/clickhouse": patch
---

Reject missing or incomplete query responses instead of treating them as absent migration journal entries or query status, while preserving valid empty results and bodyless commands.
