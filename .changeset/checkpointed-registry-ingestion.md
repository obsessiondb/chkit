---
"chkit": patch
"@chkit/plugin-ingest": patch
---

Allow registry resources to declare cursor checkpoints and timestamp windows alongside full scans. Upgrade the eight raw API integrations with provider-specific sync tokens, overlapping incremental ranges, and safe restart recovery, while preserving historical registry releases. Use one pipeline per installation with independent resource or configured collection streams, editable configuration, injectable clients, and meaningful resource readers. Attio creates independent object-type and list streams using existing full-sync pagination, with People and Companies enabled by default. GitHub separates eight raw resource types per repository, including independent issues, PRs, comments, reviews, and SHA/message commits with warehouse join keys; it no longer fetches PR files or assembles child arrays. Resources without reliable change filters use built-in full-sync completion; Calendar tokens and Lemlist activity intervals retain their necessary recovery state. Meet and Slack use recent rediscovery and coarse completed-page checkpoints, replaying unfinished children without retained-work queues. Circleback independently reads meetings, complete transcript snapshots, action items, people, and companies with replay-safe full pagination.

Update the ingestion authoring skill with the registry sync quality bar, provider capability selection, meaningful stream boundaries, normalized raw ingestion by default with transformations and joins in ClickHouse, existing pagination/checkpoint primitives, coarse replay where affordable, explicit freshness coverage, durable recovery rules, and required failure/restart verification.

Linear syncs issues, comments, projects, project updates, cycles, users, teams, issue relations, and issue history into nine independent raw destinations. Seven resources own update-time windows; relations and history use complete full reads, with history discovering all issues independently of parent progress. Preserve raw relationship IDs and complete issue label names as strings, and leave joins and metrics to ClickHouse. Populate new destinations independently and migrate retained legacy nested comments deliberately.

Treat repeated pagination continuations as permanent provider-protocol errors so reader retries cannot repeatedly replay a cyclic collection.

Add per-integration changelog metadata, shown in registry inspection and integration guides. Keep one draft release per integration in each PR, refresh it in place until merge, and validate release artifacts against the PR base to protect published versions and changelog history.
