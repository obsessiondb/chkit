---
"chkit": patch
---

`chkit ingest statsu` now exits 1 with an `unknown_subcommand` error naming the available subcommands instead of printing help with exit 0. The forwarded `chkit plugin ingest statsu` also fails, preserving its existing string-error JSON shape. Flag errors from `chkit ingest <command> --json` emit a JSON error envelope on stdout; `chkit ingest run --help` lists that subcommand's own flags; and `chkit ingest` without the plugin configured reports `plugin_not_configured` like `codegen` and `pull`.

`chkit add <unknown>` from a local registry and a failed registry request now name the missing template or the network cause instead of a bare ENOENT or "fetch failed".
