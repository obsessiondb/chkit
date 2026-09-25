---
title: ClickHouse compatibility
description: Which ClickHouse versions and engines chkit supports, and which features are version-gated.
---

The chkit team develops and tests against [ObsessionDB](/obsessiondb/overview/) (managed ClickHouse with `SharedMergeTree`) and recent open-source ClickHouse releases.

## Supported versions

Use **ClickHouse 24.x or newer**, whether self-hosted, ClickHouse Cloud, or ObsessionDB. chkit uses SQL DDL and the HTTP interface. The team does not test older versions; they may reject generated DDL.

The continuous test suite runs against ObsessionDB, so the `SharedMergeTree`/`Shared*` engine families and ObsessionDB-specific DDL are the main test targets. Vanilla single-node ClickHouse is supported for standard `MergeTree`-family engines.

## Version-gated features

A few schema features depend on the ClickHouse version of your target:

| Feature | Requirement |
|---------|-------------|
| API sync `rawTable` (native `JSON`) | Native JSON is production-ready on **25.3+**. For older targets, use a [custom destination](/api-sync/destinations/) with supported column types. See the [ClickHouse JSON reference](https://clickhouse.com/docs/reference/data-types/newjson). |
| [Refreshable materialized views](/schema/refreshable-views/) | Production-ready on **24.10+** (no flag). Experimental and flag-gated on 23.12–24.9. chkit targets 24.10+. |
| `set` data-skipping index | **ClickHouse 26+** requires the `set(0)` form rather than a bare `set`; chkit emits `set(maxRows)` accordingly. See the [DSL reference](/schema/dsl-reference/). |
| `uniqueKey` | Renders `UNIQUE KEY` DDL, which is supported on ObsessionDB / ClickHouse Cloud engines but rejected by vanilla `MergeTree`. |
| [`dictionary()`](/schema/dsl-reference/#dictionary) | DDL `CREATE DICTIONARY` only: supported broadly on 21.x+. chkit does not model XML-config dictionaries or `RENAME`/`SYSTEM RELOAD DICTIONARY`. |

If you target a single-node open-source ClickHouse, prefer the standard `MergeTree` engine family and avoid the Cloud/Shared-only features above.

## Related pages

- [Configuration overview](/configuration/overview/): connection and engine settings
- [Refreshable materialized views](/schema/refreshable-views/): version requirements in detail
- [Troubleshooting](/guides/troubleshooting/): common errors and fixes
