---
"@chkit/plugin-pull": patch
---

Route `chkit pull` introspection through the host-provided executor instead of always opening its own ClickHouse connection. When an ObsessionDB service is selected, pull now introspects through the ObsessionDB API (the same executor `generate`/`migrate`/`status` use) rather than silently falling back to `http://localhost:8123` and failing with "connection refused" while printing `using service <name>`. A direct ClickHouse target is unchanged, custom introspectors still open their own raw connection, and a run with no reachable target now errors with an actionable message instead of a misleading localhost fallback.
