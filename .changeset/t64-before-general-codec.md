---
"chkit": patch
"@chkit/core": patch
---

Accept the typed `T64` codec before a general codec (#434). ClickHouse accepts `CODEC(T64, LZ4)`, `CODEC(T64, ZSTD(3))` and `CODEC(Delta, T64, LZ4)`, but chkit classed `T64` as a general codec, so those chains failed validation with `codec_chain_multiple_general` and needed `codec.raw`. `T64` compresses on its own, like `DoubleDelta`, so it moved from `GeneralColumnCodec` to `PreprocessingColumnCodec`: a lone `T64` still validates, a chain such as `[{ kind: 'T64' }, { kind: 'LZ4' }]` now validates and renders `CODEC(T64, LZ4)`, and `T64` after a general codec (`[LZ4, T64]`, which ClickHouse rejects) fails with `codec_chain_must_end_with_general`. A migrated `T64` chain reports no drift.
