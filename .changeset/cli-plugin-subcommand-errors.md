---
"chkit": patch
---

An unknown `chkit ingest` subcommand now exits 1 with `unknown_subcommand` instead of printing help, flag errors under `--json` print a JSON error envelope, and `chkit ingest <command> --help` lists that subcommand's flags. `chkit add` errors name the missing template or the network cause instead of a bare ENOENT or "fetch failed".
