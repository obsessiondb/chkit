---
"chkit": patch
---

Add a `chkit skills` command that proxies to the external `skills` CLI (e.g. `chkit skills add obsessiondb/chkit` runs `npx skills add obsessiondb/chkit`). The agent skill is installed by the separate `skills` tool, not a chkit subcommand, so users who reached for `chkit skills add …` previously hit "Unknown command: skills". The command forwards its arguments and passes through the underlying exit code, and is handled before config loading so it works without a project.
