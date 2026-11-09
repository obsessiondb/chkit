After a `--`, `-h`, `--help` and `--json` are arguments, as in TS: `chkit generate -- --help`
reports an unexpected argument instead of printing the help, and a `--json` after `--` no
longer adds a JSON error envelope (#614).
