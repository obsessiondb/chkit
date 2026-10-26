---
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

`chkit check` now judges a backfill plan sent with the ObsessionDB managed `submit` by its job (#304). The job runs server-side and never writes a local run, so the backfill check counted the saved plan as a pending required backfill (`backfill_required_pending`) until the plan file was deleted by hand, even after the job completed.

`submit` now records the job ID in `<metaDir>/backfill/submissions/<planId>.json`. The backfill check leaves such a plan to its job backend and counts it in a new `submittedCount`; a local run of the plan, once it exists, still decides its result. The ObsessionDB plugin's check asks the jobs API for each submitted job without a local run, whatever the check target: a completed job passes and its confirmation is saved in the submission file, so later checks skip the API call; a pending or running job fails with `obsessiondb_backfill_job_incomplete`, a failed or cancelled one with `obsessiondb_backfill_job_failed` (with the last task error), and a missing or expired session or an API error with `obsessiondb_backfill_job_unverified`. The result carries `backfillJobs` counts. Projects without submitted plans make no API call. CI that runs `chkit check` needs an ObsessionDB session until every submitted job is confirmed completed. The backfill SDK exports `recordBackfillSubmission`, `listRemoteSubmissions` and `confirmBackfillSubmission`.
