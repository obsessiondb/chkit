---
"chkit": patch
"@chkit/clickhouse": patch
---

Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
