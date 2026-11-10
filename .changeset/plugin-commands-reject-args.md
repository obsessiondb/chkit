---
"chkit": patch
---

Plugin commands can declare `takesArgs: false`; chkit then rejects any argument given to them, as it does for its own commands, so `chkit obsessiondb login -- -h` and `chkit codegen -- -h` fail with `Got unexpected extra argument(s)` instead of logging in or writing files.
