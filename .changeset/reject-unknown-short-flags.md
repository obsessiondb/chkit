---
"chkit": patch
---

CLI arguments match chkit-py: supported short flags work, unknown flags, missing values, stray arguments and invalid `--connect` choices fail before hooks or file writes, `--` ends flag parsing, and the last `--config` wins. Help and argument errors work outside projects, installed pull/codegen shortcuts work without plugin registration, and `--table` is accepted only where it scopes the command.

- Breaking: drop `--table` from `chkit status`, `codegen` and `pull` invocations; it never narrowed them.
