---
"chkit": patch
---

`chkit migrate` lists every destructive statement once, under its own name, in the prompt and in `destructiveOperations`, including one hand-appended to a generated migration or placed after a commented-out statement, which previously went unlisted or under the wrong name.
