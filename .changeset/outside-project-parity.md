---
"chkit": patch
---

Outside a project, `chkit codegen --help` and `chkit pull --help` now print the help instead of a missing config error, and `chkit obsessiondb --bogus` reports an unknown command (exit 1) instead of printing the help, as in chkit-py.
