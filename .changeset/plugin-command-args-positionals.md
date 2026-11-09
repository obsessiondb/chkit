---
"chkit": patch
---

`chkit plugin <name> <command>` passes a plugin command only its positional arguments in `args`, as `chkit <name> <command>` does, instead of every token including its flags; `--` now ends a plugin command's flags, so the tokens after it reach `args` as they are, instead of failing with `Unknown flag: --` (#568).
