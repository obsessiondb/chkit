---
"@chkit/core": patch
---

Typed `GCD` codec chains such as `[{ kind: 'GCD' }, { kind: 'LZ4' }]` now validate (#408). A chain of only `Delta` and `GCD` steps, which ClickHouse rejects, now fails validation with `codec_chain_must_end_with_general`.
