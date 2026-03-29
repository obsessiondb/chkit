---
"chkit": patch
"@chkit/plugin-obsessiondb": patch
---

Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
