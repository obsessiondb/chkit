---
"chkit": patch
"@chkit/core": patch
---

`chkit migrate` now pairs each `-- operation:` marker with the statement right after it, so a statement without a marker no longer shifts later markers onto the wrong statements, for example running a `CREATE TABLE` as the async load below it (#831). Such a hand-written file may now need `--allow-destructive` for an unmarked destructive statement that used to inherit another statement's marker.
