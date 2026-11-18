---
"chkit": patch
---

Outside a project, `chkit codegen --help` now prints the help instead of a missing config error, a user profile without a project config shows and accepts the ObsessionDB flags in `--help`, `--help-plugins` and argument checks, and `chkit obsessiondb --bogus` reports an unknown command (exit 1) instead of printing the help, as in chkit-py.
