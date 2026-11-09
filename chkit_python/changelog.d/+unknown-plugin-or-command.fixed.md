A failing command no longer prints a `--json` error envelope when `--json` comes only after
`--`, as in TS (#606): `chkit plugin x -- --json` reports the unknown plugin on stderr alone.
