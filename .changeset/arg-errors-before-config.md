---
"chkit": patch
---

Outside a project, an argument error, a missing `query` SQL string or an unknown command is now reported as such, and `--help-plugins` prints the help, as in chkit-py, instead of a missing config error. Plugin commands that chkit-py has no top-level command for (`backfill`, `tinybird`, `ingest`) now report "Unknown command" there too.
