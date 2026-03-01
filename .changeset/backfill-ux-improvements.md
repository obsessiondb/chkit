---
"@chkit/plugin-backfill": patch
---

Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
