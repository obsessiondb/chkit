A plugin command's `flags` hold the global flags given, as in TS (#622): `--json` (as `True`)
in `chkit plugin <name> <command>`, `codegen` and `obsessiondb`, and `--config` (the value as
given) in `codegen` and `obsessiondb`. A flag that was not given has no key.
