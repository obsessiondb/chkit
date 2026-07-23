---
"chkit": patch
---

`chkit generate` now warns when a dictionary's `SOURCE(...)` contains a plain-text password: once when it's about to be written into the generated migration SQL file, and once when a password-only change won't produce a migration (chkit masks passwords before diffing, so that change is otherwise silent). Warnings print to the console and are included as a `warnings` array in `--json` output for both plan and apply modes.
