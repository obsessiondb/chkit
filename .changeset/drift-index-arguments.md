---
"@chkit/clickhouse": patch
"@chkit/plugin-obsessiondb": patch
"chkit": patch
---

Stop `chkit drift` from reporting `index_mismatch` for skip indexes it just created. Introspection read `system.data_skipping_indices.type`, which holds only the index name (`ngrambf_v1`), so every argument parsed as 0; it now reads `type_full` (`ngrambf_v1(3, 4096, 2, 0)`). chkit renders `INDEX name (expr)` and ClickHouse keeps those parentheses in `expr`, so the comparison now drops one pair when it encloses the whole expression. chkit-py introspection reads `type_full` as well.
