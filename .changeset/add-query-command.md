---
"chkit": patch
"@chkit/plugin-obsessiondb": patch
---

Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
