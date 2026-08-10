---
"chkit": patch
---

Make `chkit init` consistent with `create-chkit` for connecting a database, and stop hiding plugin import failures. In a non-TTY shell `init` now prints the same connect runbook `create-chkit` does (when the obsessiondb plugin is installed) instead of silently skipping it; `--yes` still keeps init a silent file-writer for CI. The dynamic plugin import now only degrades silently when the plugin is genuinely not installed — any other load failure propagates instead of a false silent pass. The static next-steps also use `npx` rather than a hardcoded `bunx`.
