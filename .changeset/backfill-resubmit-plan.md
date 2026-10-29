---
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

`chkit plugin backfill submit --plan-id <id>` re-submits a saved plan whose ObsessionDB job failed or was cancelled (#313). Before, `chkit check` kept failing with `obsessiondb_backfill_job_failed` for such a plan, and the only recovery was deleting the plan file by hand or running it locally. The new job leaves out the chunks whose task finished in the replaced job, and its ID replaces the old one in the submission file, so `chkit check` follows the new job. It starts no job when the current job is in any other state, the plan does not exist or was never submitted, or planning flags (`--target`, `--cutover`, `--from`, `--to`, `--max-chunk-bytes`) are passed with `--plan-id`; `--title` and `--concurrency` apply to the new job. With `--json`, a success adds `planId`, `replacedJobId` and `skippedChunks`. The `obsessiondb_backfill_job_failed` finding now points to `submit --plan-id`. The backfill SDK exports `readPlanSubmission`.
