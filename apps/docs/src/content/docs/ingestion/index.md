---
title: Ingestion
description: Read application APIs into ClickHouse with TypeScript streams and durable checkpoints.
---

chkit ingestion runs finite pulls from application APIs, loads rows into schema-managed ClickHouse tables, and records progress after writes succeed.

## How it fits together

Start with **API → reader → raw table → SQL view** when the final shape may change. For an established schema, map records in the reader and load typed tables. A loader writes the rows; a checkpoint records where the next execution should resume.

- A **stream** owns a stable ID, destination, reader, and incremental strategy.
- A **pipeline** groups streams, tags, concurrency limits, and retry defaults. It has no durable state and does not order dependent streams.
- A **run** executes a selection of streams once. Cron, CI, or another scheduler starts the next run.

Use TypeScript and a direct `clickhouse` connection, including for ObsessionDB databases. The workbench executor does not support ingestion. Create destination tables through schema migrations; ingestion creates its journal and writes data.

## Start

- [Quickstart](/ingestion/quickstart/): ingest a small public API and query the result.
- [Install the authoring skill](/ingestion/agent-skill/): give a coding agent the authoring workflow and relevant documentation.

## Build

- [Readers and pagination](/ingestion/readers/): provider requests, credentials, SDKs, and bounded pages.
- [Destinations and transformations](/ingestion/destinations/): raw or shaped storage, related objects, current state, and history.
- [Incremental syncs](/ingestion/incremental-syncs/): full syncs, timestamp windows, and provider state.
- [Loading and batching](/ingestion/loading/): use the default loader and tune it when needed.

## Operate

- [Scheduling and recovery](/ingestion/operations/): tags, retries, budgets, backfills, and monitoring.
- [Test a source](/ingestion/testing/): exercise checkpoints and recovery without a live database.
- [Plugin reference](/plugins/ingest/): configuration and command summary.
