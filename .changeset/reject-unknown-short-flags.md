---
"chkit": patch
---

chkit accepts the same short flags as chkit-py (#491): `-c` (`--config`), `-t` (`--table`), `generate -n` (`--name`), `pull -o`/`-d`/`-f` (`--out-file`/`--database`/`--force`) and `-V` (`--version`), as `-t x`, `-t=x` or `-tx`, and help lists them. Any other short flag, such as `-x`, is rejected with `Unknown flag: -x` and exit code 1 instead of being ignored, also by `chkit plugin <name> <command>` for a command that declares no flags.
