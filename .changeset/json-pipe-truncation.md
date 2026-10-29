---
"chkit": patch
---

`--json` output over 64 KiB is no longer cut off at 65,536 bytes when piped to a slow reader (for example `chkit plugin backfill status --job-id <id> --json | jq` on a large job, or a large `chkit query --json`). JSON is now written through `process.stdout`, and the CLI waits for stdout to drain before it exits.
