An unknown flag or a flag without its value fails as in TS (#563): `Unknown flag: <flag>` or
`Missing value for <flag>` on stderr, exit code 1 (it was 2, with click's usage banner), and
under `--json` an error envelope with code `usage` (`chkit plugin <name> <command>` keeps its
string `error`). A value flag followed by a `--` token now lacks its value, as in TS:
`generate --name --json` fails instead of naming the migration `--json`. A bundle such as
`-ax` is reported whole, and a boolean flag given a value (`--json=1`) is an unknown flag.
