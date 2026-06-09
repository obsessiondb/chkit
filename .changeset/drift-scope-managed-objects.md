---
"@chkit/core": patch
"chkit": patch
---

Stop reporting unmanaged tables as drift by default. On a shared database, every object chkit doesn't manage was emitted as `extra_object` and set `drifted = true`, so `drift` always reported drift and `check` (which defaults to `failOnDrift: true`) failed the CI gate permanently for unrelated reasons. Objects that exist in ClickHouse but are not in your schema are now reported for visibility but no longer count as drift. A new `check.failOnExtraObjects` option (default `false`) opts back into treating them as drift, for when chkit owns the entire database.
