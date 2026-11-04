---
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

`chkit check` judges a backfill plan sent with ObsessionDB `submit` by its job instead of reporting it as pending until the plan file is deleted; an unfinished, failed or unverifiable job fails the check (#304). CI that runs `chkit check` needs an ObsessionDB session until every submitted job is confirmed completed.
