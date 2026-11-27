---
"chkit": patch
---

Plugin commands receive only positional arguments through either spelling, honor `--`, reject invalid flags before hooks, and can reject positionals with `takesArgs: false` or declare short flags with `FlagDef.short`. Plugin listings show only configured plugins and fail clearly when none are configured.

- Breaking: a plugin command that skipped `args[0]` because it held its own name must stop doing so.
