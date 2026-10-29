---
"@chkit/plugin-obsessiondb": patch
---

`chkit plugin backfill status --service-slug <slug> --json` and `chkit plugin backfill list --json` against ObsessionDB now report the `service_not_found` or `service_not_in_active_organization` error code when the service lookup fails, instead of the generic `error`, matching the Python port.
