---
"chkit": patch
---

`chkit drift` and `chkit check` no longer report `engine_mismatch` for a `Replicated*` table on ObsessionDB or ClickHouse Cloud, which store it as `Shared*` without the Keeper path and replica name.
