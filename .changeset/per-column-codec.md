---
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"chkit": patch
---

Add support for per-column compression codecs.

Declare a codec directly on a column with a structured discriminated union:

```ts
import { codec, table } from '@chkit/core'

const events = table({
  database: 'analytics',
  name: 'events',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'ts', type: 'DateTime', codec: { kind: 'ZSTD', level: 3 } },
    { name: 'delta', type: 'Int64', codec: [{ kind: 'Delta', size: 4 }, { kind: 'ZSTD' }] },
    { name: 'exp', type: 'Float32', codec: codec.raw('SomeNewCodec(42)') },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})
```

Highlights:
- `CREATE TABLE` and `ALTER TABLE ADD/MODIFY COLUMN` emit the `CODEC(...)` clause in the correct position (after `DEFAULT` and `COMMENT`, as required by ClickHouse).
- `chkit generate` emits `MODIFY COLUMN ... REMOVE CODEC` when a codec is dropped and no other column fields change; otherwise a single `MODIFY COLUMN` replaces the codec.
- `chkit pull` introspects `system.columns.compression_codec` and renders structured codec objects back into the schema file. Unknown codec tokens fall back to `codec.raw(...)` so new ClickHouse codecs still round-trip.
- Canonicalization fills ClickHouse defaults (`ZSTD` → level 1, `LZ4HC` → level 9, `Delta`/`DoubleDelta`/`Gorilla` → size 1), so `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal and the diff engine stays stable across pull → plan round-trips.
- Validation catches codec chains with more than one general codec, chains that do not end with a general codec, or an empty chain (`codec: []`) — preprocessor alone is accepted since ClickHouse auto-appends the default general codec.
- `parseCodec` falls back to `raw` when a known codec token has unexpected extra args (e.g. `ZSTD(3, 1)`), so future ClickHouse codec extensions round-trip cleanly through `chkit pull` instead of silently dropping arguments.
