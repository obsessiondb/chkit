---
"@chkit/plugin-obsessiondb": patch
---

`chkit obsessiondb service alias set` rejects an alias that starts with `-`, which the command line would read as a flag (#491).
