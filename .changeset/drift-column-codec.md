---
"chkit": patch
"@chkit/core": patch
---

`chkit drift` and `chkit check` now compare column codecs: a codec added, removed or changed on the server reports `changed_column`. Codecs are compared in the form ClickHouse stores them, so `ZSTD` matches `ZSTD(1)`, `LZ4HC` matches `LZ4HC(0)`, and `DoubleDelta(4)` and `FPC(12, 8)` match the `DoubleDelta` and `FPC(12)` ClickHouse keeps. Introspection also reads a negative codec level (`ZSTD(-1)`, stored as `ZSTD(18446744073709551615)`) back as negative.
