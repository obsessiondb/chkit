---
"chkit": patch
"@chkit/core": patch
---

Class the typed `GCD` codec as a preprocessing codec (#408). ClickHouse rejects a lone `CODEC(GCD)` because GCD does not compress, and chkit classed it as a general codec, so no typed GCD chain was valid: `[{ kind: 'GCD' }, { kind: 'LZ4' }]` now validates and renders `CODEC(GCD, LZ4)`, and `GCD` moved from `GeneralColumnCodec` to `PreprocessingColumnCodec`. A chain made only of `Delta` and `GCD` steps, such as a lone `GCD` or `Delta`, which ClickHouse rejects for the same reason, now fails validation with `codec_chain_must_end_with_general` before reaching the server.
