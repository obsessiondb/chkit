---
"@chkit/plugin-obsessiondb": patch
---

The ObsessionDB remote executor now sends per-insert `settings` (such as `insert_deduplication_token`) with `insert`. Before, it silently dropped them, so an insert retried through it was not deduplicated.
