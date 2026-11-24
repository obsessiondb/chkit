---
"@chkit/plugin-obsessiondb": patch
---

ObsessionDB CLI service pickers keep prompts on stderr and avoid waiting for choices without a terminal, while service usage and errors preserve valid `--json` output. Aliases beginning with `-` are rejected, and a missing ObsessionDB plugin reports `plugin_not_configured` while help remains available.
