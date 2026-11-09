---
"chkit": patch
---

`chkit init` rejects an unknown flag, long or short, or a flag missing its value with exit code 1 before writing any file, instead of ignoring it (#491).
