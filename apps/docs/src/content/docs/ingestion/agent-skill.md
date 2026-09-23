---
title: Ingestion authoring skill
description: Install a concise agent skill for implementing new chkit ingestion sources.
---

Install `chkit-ingestion` to give your coding agent source-authoring instructions and links to the relevant guides.

## Install

From the application project:

```sh
npx skills add obsessiondb/chkit --skill chkit-ingestion
```

The TypeScript CLI also provides a pass-through:

```sh
chkit skills add obsessiondb/chkit --skill chkit-ingestion
```

Choose the agent in the installer. Install `@chkit/plugin-ingest` and configure credentials through the [quickstart](/ingestion/quickstart/) before running a sync. The separate `chkit` skill covers schema and migration workflows.

For a local checkout containing the skill, use:

```sh
npx skills add ./skills/chkit-ingestion
```

Use the repository install command after the skill reaches the default branch. Use the local command to install from an unpublished checkout.

## Use it

For an agent supporting explicit skill invocation:

```text
Use $chkit-ingestion to add a source for our helpdesk tickets.
Inspect the existing schema and provider documentation first.
Explain the choices for stored shape, transformations, incremental state,
and loading, then implement the reader and tests.
```

Include provider documentation, example responses, freshness needs, and any restrictions on storing raw fields. The agent should derive decisions from those facts and the existing project.

## Skill scope

The skill covers the authoring steps and requirements for bounded readers, checkpoint ordering, write identity, and scheduling. Use the linked docs for complete examples and tradeoffs.

## Related pages

- [Destinations and transformations](/ingestion/destinations/): choose storage and mapping for the source.
- [Quickstart](/ingestion/quickstart/): a working first source.
- [For AI agents](/ai-agents/): general chkit setup and schema workflows.
