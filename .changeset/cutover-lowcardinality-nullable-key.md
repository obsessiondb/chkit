---
"chkit": patch
---

`generate --cutover` rejects nullable keys, including `LowCardinality(Nullable(T))` and commented or quoted type spellings. `generate`, cutover planning and `drift` distinguish one key column containing commas or spaces from multiple columns while accepting equivalent key spellings.
