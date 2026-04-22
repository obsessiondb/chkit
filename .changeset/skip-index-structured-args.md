---
"@chkit/core": major
"@chkit/clickhouse": major
"@chkit/plugin-pull": major
"chkit": major
---

**Breaking:** Skip indexes now use a structured discriminated union instead of a free-form `typeArgs: string` field. Each index `type` has its own typed fields, which moves argument validation from runtime to the type system.

```ts
indexes: [
  // before
  { name: 'idx_set', expression: 'source', type: 'set', typeArgs: '0', granularity: 1 },
  // after
  { name: 'idx_set', expression: 'source', type: 'set', maxRows: 0, granularity: 1 },
]
```

### Migration guide

| Old (`typeArgs`)                               | New (structured)                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `type: 'minmax'`                               | `type: 'minmax'`                                                              |
| `type: 'set', typeArgs: '0'`                   | `type: 'set', maxRows: 0`                                                     |
| `type: 'set', typeArgs: '1000'`                | `type: 'set', maxRows: 1000`                                                  |
| `type: 'bloom_filter'`                         | `type: 'bloom_filter'`                                                        |
| `type: 'bloom_filter', typeArgs: '0.01'`       | `type: 'bloom_filter', falsePositiveRate: 0.01`                               |
| `type: 'tokenbf_v1', typeArgs: '32768, 3, 0'`  | `type: 'tokenbf_v1', sizeBytes: 32768, hashFunctions: 3, randomSeed: 0`       |
| `type: 'ngrambf_v1', typeArgs: '3, 256, 2, 0'` | `type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0` |

Highlights:
- `set` now requires `maxRows` at the type level — forgetting it is a TypeScript error rather than a runtime validation failure.
- `tokenbf_v1` and `ngrambf_v1` have typed `sizeBytes`, `hashFunctions`, `randomSeed` (and `ngramSize` for ngram), so positional argument mistakes are caught at compile time.
- `bloom_filter` keeps `falsePositiveRate` optional — omit it to emit a bare `bloom_filter` clause.
- `chkit pull` now introspects `system.data_skipping_indices.type_full` and emits the structured fields back into schema files; unknown types still round-trip via the existing path.
- The `index_type_missing_args` validation code is removed since it is now a compile-time concern.
