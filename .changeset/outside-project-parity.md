---
"chkit": patch
---

Outside a project, `chkit codegen --help` now prints the help instead of a missing config error, `--help` and `--help-plugins` work under a user profile without a project config, and `chkit obsessiondb --bogus` reports an unknown command (exit 1) instead of printing the help, as in chkit-py.
