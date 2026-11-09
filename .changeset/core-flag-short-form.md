---
"@chkit/core": patch
---

A plugin flag (`FlagDef`) can declare a short form with `short: '-o'`; `parseFlags` reads it as the long flag, and the new `expandShortFlags` rewrites declared short flags to their long form.
