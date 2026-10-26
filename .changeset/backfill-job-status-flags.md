---
"@chkit/plugin-obsessiondb": patch
"chkit": patch
---

`chkit plugin backfill status --job-id <jobId>` and `cancel --job-id <jobId>` work as documented (#303). `chkit plugin <name> <command>` now accepts the flags other plugins extend onto that plugin, as `chkit <name> <command>` already did, so ObsessionDB's `--job-id`, `--service-slug` and `--local` no longer fail with `Unknown flag`. The remote job commands print the job in text mode (status, tasks completed and failed, the last error, and a console link when a service is known) instead of nothing, and `--json` returns the standard `command`/`schemaVersion`/`ok` envelope instead of the raw console API object. A missing flag or an API failure prints an error (an error envelope under `--json`) and exits 1.
