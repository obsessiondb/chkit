An argument that is not a flag (`chkit status foo`, `chkit init foo`) fails as in TS (#612):
`Got unexpected extra argument(s) (foo)` on stderr, exit code 1 (it was 2, with click's usage
banner), and under `--json` an error envelope with code `usage` (it was `error`).
