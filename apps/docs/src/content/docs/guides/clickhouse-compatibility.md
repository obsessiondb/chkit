---
title: ClickHouse compatibility
description: Which ClickHouse versions and engines chkit supports, and which features are version-gated.
---

chkit is developed and tested against [ObsessionDB](/obsessiondb/overview/) (a managed ClickHouse running the `SharedMergeTree` engine) and recent open-source ClickHouse releases.

## Supported versions

chkit targets **ClickHouse 24.x and newer**. It uses standard SQL DDL and the HTTP interface, so it works against any reasonably recent ClickHouse — self-hosted, ClickHouse Cloud, or ObsessionDB. Older versions are not tested and may reject some generated DDL.

The continuous test suite runs against ObsessionDB, so the `SharedMergeTree`/`Shared*` engine families and ObsessionDB-specific DDL are the most heavily exercised paths. Vanilla single-node ClickHouse is supported for standard `MergeTree`-family engines.

## Version-gated features

A few schema features depend on the ClickHouse version of your target:

| Feature | Requirement |
|---------|-------------|
| [Refreshable materialized views](/schema/refreshable-views/) | Production-ready on **24.10+** (no flag). Experimental and flag-gated on 23.12–24.9. chkit targets 24.10+. |
| `set` data-skipping index | **ClickHouse 26+** requires the `set(0)` form rather than a bare `set`; chkit emits `set(maxRows)` accordingly. See the [DSL reference](/schema/dsl-reference/). |
| `uniqueKey` | Renders `UNIQUE KEY` DDL, which is supported on ObsessionDB / ClickHouse Cloud engines but rejected by vanilla `MergeTree`. |
| [`dictionary()`](/schema/dsl-reference/#dictionary) | DDL `CREATE DICTIONARY` only — supported broadly on 21.x+. chkit does not model XML-config dictionaries or `RENAME`/`SYSTEM RELOAD DICTIONARY`. |

If you target a single-node open-source ClickHouse, prefer the standard `MergeTree` engine family and avoid the Cloud/Shared-only features above.

## Related pages

- [Configuration overview](/configuration/overview/) — connection and engine settings
- [Refreshable materialized views](/schema/refreshable-views/) — version requirements in detail
- [Troubleshooting](/guides/troubleshooting/) — common errors and fixes
