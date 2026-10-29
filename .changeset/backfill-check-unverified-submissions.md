---
"@chkit/plugin-backfill": patch
---

`chkit check` no longer passes a submitted backfill that nothing verifies (#326). The backfill check leaves a plan sent with `submit` to the ObsessionDB plugin, which asks the jobs API whether its job completed. When that plugin is not loaded, for example on a CI runner where only a local login session had added it to the config, the plan passed unchecked. The backfill check now reports submitted plans not yet confirmed completed as `backfill_submitted_unverified` when no ObsessionDB plugin is registered, with the same severity as `backfill_required_pending` (an error unless `failCheckOnRequiredPendingBackfill` is `false`). The configuration docs now describe how the TypeScript CLI layers the user profile, including the ObsessionDB plugin a login session adds, under a project config.
