---
"chkit": patch
---

`chkit query` rejects an unknown flag such as `-x` or `--bogus` with `Unknown flag: -x` instead of running it as SQL or reporting it as a second SQL string (#584). SQL that starts with a line comment, and anything after `--`, is still read as SQL.
