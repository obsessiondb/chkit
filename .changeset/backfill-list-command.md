---
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

`chkit plugin backfill list` lists the backfill jobs of an ObsessionDB service (#311). The ObsessionDB plugin handled `list`, but the backfill plugin registered no `list` command, so the CLI rejected it before the hook ran. `--service-slug` is now optional and defaults to the selected service; without either, `list` exits 1 and asks for one. Without the ObsessionDB plugin (or with `--local`), `list` exits 2 and explains how to set up a managed backend. `status --service-slug` still lists a service's jobs.
