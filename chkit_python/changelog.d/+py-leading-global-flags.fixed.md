Global flags work before the command, as in TS (#597): `chkit --json status` and
`chkit -c cfg.py generate` run the command instead of failing with `No such option`. A first
token that is not a command (`chkit nope`, `chkit --nope status`, `chkit -vx`) fails as
`Unknown command: <token>` with exit code 1 (it was 2), and under `--json` with an
`unknown_command` error envelope.
