---
"chkit": patch
---

`--` ends the flags of `init`, `generate`, `migrate`, `status`, `drift`, `check` and `snapshot`, as in chkit-py: a trailing `--` is ignored and what follows it is an argument, which a command that takes none rejects with `Got unexpected extra argument(s) (...)`, where every `--` was an unknown flag (#614).
