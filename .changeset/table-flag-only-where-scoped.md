---
"chkit": patch
---

`--table`/`-t` is accepted only by `generate`, `migrate`, `check` and `drift` (and rejected by `snapshot rebuild` as before). `status`, `query`, `codegen`, `pull`, the other plugin commands and `chkit plugin <name> <command>` now reject it as an unknown flag instead of ignoring it and running unscoped (#565).

- Breaking: drop `--table` from `chkit status`, `codegen` and `pull` invocations; it never narrowed them.
