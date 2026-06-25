---
"@chkit/plugin-obsessiondb": patch
---

Send a versioned `User-Agent: chkit/<version>` to the ObsessionDB API (oRPC query client and auth client) instead of a flat `chkit-cli`. This matches the direct-ClickHouse executor's identity and lets the API forward the header so CLI traffic is attributable in `system.query_log.http_user_agent`.
