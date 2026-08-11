---
title: chkit is now available in Python
description: "chkit-py brings the full ClickHouse schema-as-code toolkit to Python, at parity with the TypeScript original. What it covers, how the two implementations stay in sync, and what is different in Python."
date: 2026-08-11
authors: obsessiondb
excerpt: "We closed our last post with a promise: a Python port in the coming weeks. It shipped. pip install chkit-py gets you the entire toolkit, at parity with the TypeScript original: same DSL semantics, same planner, same journal table, same CLI."
tags:
  - announcement
  - clickhouse
  - python
---

We closed [our last post](/blog/olap-deserves-better-tooling/) with a promise: if you do not use TypeScript but Python, a port was coming. It shipped.

```sh
pip install chkit-py
chkit --help
```

That is the entire ClickHouse® schema-as-code toolkit, ported to Python at parity with the TypeScript original: the DSL, the diff engine, the migration planner, the drift detection, the CI gates, and the plugins. It is not a wrapper around a Node binary. A wrapper would still put a Node runtime in your Airflow images and give Python nothing importable. It is a full port, with Pydantic models, a library API, and a CLI that is just `chkit` on your PATH.

This post covers why we built it, how the two implementations stay in sync, and what is different on the Python side.

## The people closest to ClickHouse write Python

Look at who actually sits next to a ClickHouse cluster all day. Data engineers orchestrating pipelines in Airflow and Dagster. Analytics engineers living in notebooks. ML teams whose entire world is pandas, Polars, and PyArrow. The queries feeding your dashboards were probably prototyped in a Jupyter cell.

For that whole population, a schema tool that only exists on npm is a tax. Adopting chkit meant adopting a Node toolchain (`package.json`, a runtime, a lockfile) in repositories that had none, maintained by people who did not choose JavaScript and should not have to. Most teams do the rational thing instead: they keep hand-writing DDL, which is exactly the failure mode chkit exists to eliminate.

## Agents default to Python

Coding agents are the other reason. Ask an agent to script something against a database and it almost always writes Python, because that is the ecosystem it draws from.

If your schema toolkit does not exist in Python, agents route around it: they hand-write the `CREATE TABLE`, and you are back to unreviewed DDL, the exact problem chkit exists to solve. If you want agents to keep schema changes inside the migration workflow, the tool has to exist in the language they actually use.

The docs follow the same idea. Every page of [chkit.obsessiondb.com](https://chkit.obsessiondb.com) is available as raw Markdown (append `.md` to any URL), there is an [llms.txt](https://chkit.obsessiondb.com/llms.txt) index at the root, and every reference page now shows TypeScript and Python side by side with synced tabs: pick your language once, and the whole site follows. An agent (or a human) landing anywhere in the docs gets working code in the language it is actually going to run.

## The same schema, in Python

Here is the table from our last post, in Python:

```python
from chkit import schema, table

events = table(
    database="analytics",
    name="events",
    columns=[
        {"name": "id", "type": "UInt64"},
        {"name": "org_id", "type": "String"},
        {"name": "source", "type": "LowCardinality(String)"},
        {"name": "payload", "type": "String", "nullable": True},
        {"name": "received_at", "type": "DateTime64(3)", "default": "fn:now64(3)"},
    ],
    engine="MergeTree()",
    primary_key=["id"],
    order_by=["org_id", "received_at", "id"],
    partition_by="toYYYYMM(received_at)",
    ttl="received_at + INTERVAL 90 DAY",
    settings={"index_granularity": 8192},
    indexes=[
        {"name": "idx_source", "expression": "source", "type": "set", "maxRows": 0, "granularity": 1},
    ],
)

definitions = schema(events)
```

Definitions are Pydantic models: frozen, validated at construction, unknown fields rejected. A typo in a column option fails loudly at import time instead of silently shipping a table with no codec. The DSL accepts both snake_case and the TypeScript camelCase names (`primary_key` or `primaryKey`), so examples port between languages with their keys unchanged.

The CLI is the same CLI. Same commands, same flags, same exit codes, same `--json` envelopes:

```sh
chkit generate --name add_events_table
chkit migrate            # shows the plan
chkit migrate --apply    # applies, journals, verifies checksums
chkit drift
chkit check --strict     # your CI gate
```

Everything from the last post carries over. The guardrails: risk-tagged plans, the structural-vs-alterable distinction, tracked renames, destructive-operation blocking with exit code 3, checksum-verified migration history. The schema surface: dictionaries, refreshable materialized views, projections, `ON CLUSTER` mode. The ecosystem: `pull` for adopting an existing database (a built-in command in Python, no plugin to install), the codegen plugin (which emits Pydantic models, one shape covering what TypeScript needed interfaces *and* Zod for), the backfill engine, and the ObsessionDB integration.

## Two implementations, one source of truth

A second implementation is only useful if the two never disagree. chkit-py and chkit share their artifacts:

- **The snapshot** (`chkit/meta/snapshot.json`) serializes with identical JSON shapes. A snapshot written by the TypeScript CLI is read by the Python CLI, and vice versa.
- **The journal** is the same `_chkit_migrations` table in ClickHouse, same schema, same SHA-256 checksums.
- **The SQL**: both planners render the same DDL for the same definitions, statement for statement, down to how ClickHouse normalizes projection index parentheses.

Which means a TypeScript service and a Python pipeline can manage the *same database* without stepping on each other. Your app team stays in TS, your data team stays in Python, and there is still exactly one source of truth with one migration history.

Keeping that guarantee was most of the porting work, down to matching JavaScript's number formatting so a plan written by one implementation runs unchanged under the other. It is verified by 1,100+ tests (most ported case-for-case from the TypeScript suites) that run in the same CI on every commit, plus an e2e suite per implementation against live ClickHouse. The deliberate differences between the two are documented in [`DRIFT.md`](https://github.com/obsessiondb/chkit/blob/main/chkit_python/DRIFT.md).

A few things intentionally did not cross over: the `create chkit` scaffolder (`chkit init` covers it), dependency auto-install (Python convention is an explicit `pip install`), the `chkit skills` proxy, and two codegen extras (ingest helpers and an embedded migration runner) that are deferred until Python users ask for them.

## Start from where you already are

Same story as the TypeScript side, minus the toolchain:

```sh
pip install chkit-py
chkit init                    # writes clickhouse.config.py + a starter schema
chkit generate --name init
chkit migrate --apply
```

Already running ClickHouse? `chkit pull` introspects the live database and writes a deterministic Python schema file with everything in it: tables, views, materialized views, dictionaries, codecs, projections. Then `chkit drift` confirms the result matches before you change anything.

Config is a plain Python module (`clickhouse.config.py`), reading credentials from environment variables, with the same options and defaults as the TypeScript config, including function-style configs for CI. The three first-party plugins ship inside the package; there is nothing else to install.

## One toolkit, whatever the language

Last time we argued that ClickHouse deserves the migration tooling relational databases have had for years. That argument no longer depends on your language: if you run ClickHouse from Python, chkit now works the same way it does from TypeScript.

- **Install:** <https://pypi.org/project/chkit-py/>
- **Docs:** <https://chkit.obsessiondb.com/python/overview/>
- **Repo:** <https://github.com/obsessiondb/chkit> (MIT, the Python port lives in `chkit_python/`)

Same disclosure as last time: we run [ObsessionDB](https://obsessiondb.com), a managed ClickHouse offering, and chkit-py, like chkit, runs against ObsessionDB, ClickHouse Cloud, Altinity, or any self-hosted ClickHouse. No lock-in; the tooling is for the ecosystem.

It is beta, like its TypeScript sibling: the CLI surface and the DSL are stable, but we may make small breaking changes before 1.0. If something is missing, or the Python ergonomics could be better, issues and PRs are welcome. Improvements land in both languages.

Stay tuned!

---

*ClickHouse® is a registered trademark of ClickHouse, Inc.*
