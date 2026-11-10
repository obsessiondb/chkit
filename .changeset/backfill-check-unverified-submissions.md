---
"@chkit/plugin-backfill": patch
---

`chkit check` no longer passes a submitted backfill plan when no ObsessionDB plugin is loaded to verify it; it reports `backfill_submitted_unverified` with the same severity as `backfill_required_pending` (#326).
