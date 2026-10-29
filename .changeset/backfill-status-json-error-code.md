---
"@chkit/plugin-obsessiondb": patch
---

`chkit plugin backfill status|cancel --json` against ObsessionDB now reports the `service_not_found` or `service_not_in_active_organization` error code when the service lookup fails, instead of the generic `error`, matching the Python port.
