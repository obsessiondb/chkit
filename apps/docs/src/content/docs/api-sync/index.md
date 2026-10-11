---
title: API sync model
description: Understand the streams, pipelines, and checkpoints used by chkit Sync (beta).
---

[chkit Sync (beta)](/sync/) runs finite pulls from application APIs, loads rows into schema-managed ClickHouse tables, and records progress after writes succeed.

## How it fits together

Start with **API → reader → raw table → SQL view** when the final shape may change. For an established schema, map records in the reader and load typed tables. A loader writes the rows; a checkpoint records where the next execution should resume.

- A **stream** owns a stable ID, destination, reader, and incremental strategy.
- A **pipeline** groups streams, tags, concurrency limits, and retry defaults. It has no durable state and does not order dependent streams.
- A **run** executes a selection of streams once. Cron, CI, or another scheduler starts the next run.

Use TypeScript and a direct `clickhouse` connection, including for ObsessionDB databases. The workbench executor does not support API sync. Create destination tables through [chkit Schema migrations](/tutorials/first-schema/); ingestion creates its append-only checkpoint journal before writing data. [Overlapping runs](/api-sync/operations/#overlapping-runs-and-checkpoint-recovery) record independent histories and may replay acknowledged work.

Schema management defines the destination structure. chkit Sync adds readers and execution: a run does not generate or apply destination migrations, and it does not schedule the next run.

## Start

- [Apps & integrations](/integrations/): browse the registry and each app's complete sync guide.
- [Provider templates](/api-sync/templates/): install editable schemas and readers with one command.
- [Integrating ClickHouse with Attio](/integrations/attio/): sync workspace objects, records, lists, notes, tasks, and members.
- [Integrating ClickHouse with Slack](/integrations/slack/): sync conversations, users, retained messages, and thread replies into raw tables.
- [Quickstart](/api-sync/quickstart/): ingest a small public API and query the result.
- [Install the authoring skill](/api-sync/agent-skill/): give a coding agent the authoring workflow and relevant documentation.

## Build

- [Readers and pagination](/api-sync/readers/): provider requests, credentials, SDKs, and bounded pages.
- [Destinations and transformations](/api-sync/destinations/): raw or shaped storage, related objects, current state, and history.
- [Incremental syncs](/api-sync/incremental-syncs/): full syncs, timestamp windows, and provider state.
- [Loading and batching](/api-sync/loading/): use the default loader and tune it when needed.
- [Publish a registry](/api-sync/registry-authoring/): distribute provider source files as versioned templates.

## Related pages

- [Scheduling and recovery](/api-sync/operations/): tags, retries, budgets, backfills, and monitoring.
- [Test a source](/api-sync/testing/): exercise checkpoints and recovery without a live database.
- [Plugin reference](/plugins/ingest/): configuration and command summary.
- [Sync CLI](/sync/cli/): discover templates, install providers, and operate streams.
