---
"chkit": minor
---

Add a `-- log: <message>` metadata key to migration files. When set, the message is printed to stdout immediately before the migration is applied, so operators see context for long-running or otherwise-noteworthy migrations (e.g. "Loading 100M rows, ~3-5 min"). Parsed from the leading `-- key: value` comment block; unknown keys are ignored so future additions stay backwards-compatible.
