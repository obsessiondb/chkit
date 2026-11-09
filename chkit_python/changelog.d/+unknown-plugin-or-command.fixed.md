An unknown plugin or plugin command fails as in TS (#606): `Unknown plugin "<name>".
Available: ...` or `Unknown <plugin> command "<command>". Available: ...` on stderr, exit
code 1 (it was 2, with click's usage banner), and the TS `--json` output. `chkit codegen`
without the codegen plugin reports `Codegen plugin is not configured` (`--json` code
`plugin_not_configured`), and an unknown `chkit obsessiondb` command uses code
`unknown_subcommand`.
