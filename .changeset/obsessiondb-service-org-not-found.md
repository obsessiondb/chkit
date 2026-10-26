---
"@chkit/plugin-obsessiondb": patch
---

Explain the bare `Not Found` a console call returns when the selected service is not in the chkit session's active organization (#305). The ObsessionDB API looks a service slug up in the session's active organization only, so `query`, `migrate`, `pull` and `backfill submit` against a service of another organization failed with `Not Found` (`NOT_FOUND` in `--json`). On a NOT_FOUND for a call that names a service, the plugin now looks up the organizations (`services.listAll`) and the session's active organization, and fails with an error that names the service, the active organization and the organization that owns it (`service_not_in_active_organization`), or says that no organization you belong to has the service (`service_not_found`). Both point to `chkit obsessiondb service select`.
