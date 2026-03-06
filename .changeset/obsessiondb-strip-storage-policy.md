---
"@chkit/plugin-obsessiondb": patch
---

Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
