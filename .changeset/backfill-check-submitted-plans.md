---
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

`chkit check` no longer fails on a backfill plan sent with the ObsessionDB managed `submit` (#304). The job runs server-side and never writes a local run, so the check counted its saved plan as a pending required backfill (`backfill_required_pending`) until the plan file was deleted by hand. `submit` now records the job ID in `<metaDir>/backfill/submissions/<planId>.json`, and the check reports such plans with the non-failing `backfill_submitted_remote` info finding (with their job IDs) and a new `submittedCount` instead. The check still does not query the backend; follow a submitted job with `chkit plugin backfill status --job-id <jobId>`. A local run of the same plan, once it exists, still decides the plan's check result. The SDK exports `recordBackfillSubmission`.
