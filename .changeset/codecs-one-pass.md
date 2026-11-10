---
"@chkit/core": patch
"@chkit/plugin-pull": patch
"chkit": patch
---

Column codecs follow ClickHouse's rules and stored forms, and `generate` reports codecs ClickHouse would reject instead of failing the migration partway (#465).

After upgrading, `generate` plans a codec change for every `Delta` or `Gorilla` column written without `size`, which chkit used to render as `Delta(1)` or `Gorilla(1)`.
