---
"chkit": patch
---

Add `migrate --apply --break-lock <claim> --cancel-lock-queries` to cancel a stopped run's tracked data loads before compensation and recovery, including SharedMergeTree backfills on servers with the truncate-fence protocol.
