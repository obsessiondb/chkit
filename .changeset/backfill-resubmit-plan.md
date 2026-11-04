---
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

`chkit plugin backfill submit --plan-id <id>` re-submits a saved plan whose ObsessionDB job failed or was cancelled, skipping chunks that already finished, and `chkit check` follows the new job (#313).
