---
title: ClickHouse compatibility
description: Which ClickHouse versions and engines chkit supports, and which features are version-gated.
---

The chkit team develops and tests against [ObsessionDB](/obsessiondb/overview/) (managed ClickHouse with `SharedMergeTree`) and recent open-source ClickHouse releases.

## Supported versions

Use **ClickHouse 24.x or newer**, whether self-hosted, ClickHouse Cloud, or ObsessionDB. chkit uses SQL DDL and the HTTP interface. The team does not test older versions; they may reject generated DDL.

The continuous test suite runs against ObsessionDB, so the `SharedMergeTree`/`Shared*` engine families and ObsessionDB-specific DDL are the main test targets. Vanilla single-node ClickHouse is supported for standard `MergeTree`-family engines.

## Version-gated features

[Kafka engine tables](/schema/kafka/) support creation, pull, and schema drift,
validated on self-hosted ClickHouse 25.3 and 26.3. Existing queue changes require
explicit replacement; generic Kafka column/settings ALTERs are not generated.
The server must provide the Kafka engine and broker connectivity.

[Distributed tables](/schema/dsl-reference/#distributed-tables) support creation,
column ALTERs, pull, and schema drift, validated on open-source ClickHouse 26.3 and
on a 2-shard ReplicatedMergeTree cluster on 25.3. ObsessionDB has no shards, so the
[ObsessionDB plugin](/obsessiondb/engine-rewriting/#distributed-tables) rejects
Distributed tables when targeting it.

chkit renders `PARTITION BY`, `PRIMARY KEY`, and `ORDER BY` only for engines that
accept them: the `MergeTree` family (including `Replicated*` and `Shared*`) and a few
others such as `EmbeddedRocksDB`, `KeeperMap`, and `S3`. Tables on `Memory`, `Null`,
`Log`, `Buffer`, `Merge`, `Distributed`, and similar engines get none, and setting a
key on them fails validation.

A few schema features depend on the ClickHouse version of your target:

| Feature | Requirement |
|---------|-------------|
| Native `JSON` columns | Native JSON is production-ready on **25.3+**. For older targets, choose column types supported by the target server. See the [ClickHouse JSON reference](https://clickhouse.com/docs/reference/data-types/newjson). |
| [Refreshable materialized views](/schema/refreshable-views/) | Production-ready on **24.10+** (no flag). Experimental and flag-gated on 23.12–24.9. chkit targets 24.10+. |
| `set` data-skipping index | **ClickHouse 26+** requires the `set(0)` form rather than a bare `set`; chkit emits `set(maxRows)` accordingly. See the [DSL reference](/schema/dsl-reference/). |
| `uniqueKey` | Renders `UNIQUE KEY` DDL, which is supported on ObsessionDB / ClickHouse Cloud engines but rejected by vanilla `MergeTree`. |
| [`dictionary()`](/schema/dsl-reference/#dictionary) | DDL `CREATE DICTIONARY` only: supported broadly on 21.x+. chkit does not model XML-config dictionaries or `RENAME`/`SYSTEM RELOAD DICTIONARY`. |

If you target a single-node open-source ClickHouse, prefer the standard `MergeTree` engine family and avoid the Cloud/Shared-only features above.

## Related pages

- [Configuration overview](/configuration/overview/): connection and engine settings
- [Refreshable materialized views](/schema/refreshable-views/): version requirements in detail
- [Troubleshooting](/guides/troubleshooting/): common errors and fixes
