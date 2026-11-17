---
"chkit": patch
---

`chkit <plugin> <command>` no longer passes the command name as the first item of the plugin command's `args`; the command gets the same `args` as through `chkit plugin <plugin> <command>` and chkit-py (#624).

- Breaking: a plugin command that skipped `args[0]` because it held its own name must stop doing so.
