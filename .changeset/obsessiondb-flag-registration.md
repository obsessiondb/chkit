---
"@chkit/plugin-obsessiondb": patch
---

Register the `--local` and `--service` overrides against the correct command keys. The command registry keys plugin flag extensions by top-level command name, so the previous two-word targets (e.g. `backfill run`) never matched — `chkit backfill plan/run/resume --local` was rejected as an unknown flag, making the local-execution escape hatch unreachable. `--service` was also never extended to `pull`, so `chkit pull schema --service <name>` failed. Both flags now parse and route correctly.
