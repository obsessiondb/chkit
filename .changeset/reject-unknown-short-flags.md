---
"chkit": patch
---

chkit rejects an unknown short flag such as `-t` or `-c` with `Unknown flag: -t` and exit code 1, like an unknown long flag, instead of ignoring it and running unscoped or with the default config (#491). `chkit plugin <name> <command>` now also rejects unknown flags for a command that declares none, as `chkit <name> <command>` and chkit-py already did.
