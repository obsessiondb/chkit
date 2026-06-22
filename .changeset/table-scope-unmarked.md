---
"chkit": patch
---

`migrate --table` no longer silently skips hand-written migrations that have no `-- operation:` markers. Their target tables can't be determined, so they are now fail-safe **included** (rather than dropped, which left pending work unapplied while appearing successful) and reported — with a warning in human output and an `undeterminedMigrations` array in `--json` output.
