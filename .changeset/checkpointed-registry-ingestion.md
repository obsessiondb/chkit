---
"chkit": patch
"@chkit/plugin-ingest": patch
---

Allow registry resources to declare cursor checkpoints and timestamp windows alongside full scans. Upgrade the eight raw API integrations with provider-specific sync tokens, overlapping incremental ranges, and safe restart recovery, while preserving historical registry releases. Use one pipeline per installation with independent resource or configured collection streams, editable configuration, injectable clients, and meaningful resource readers. Attio creates independent object-type and list streams using existing full-sync pagination, with People and Companies enabled by default. GitHub separates eight raw resource types per repository, including independent issues, PRs, comments, reviews, and SHA/message commits with warehouse join keys; it no longer fetches PR files or assembles child arrays. GitHub resources without change filters and Lemlist campaigns use built-in full-sync completion, while Calendar tokens, Meet artifacts, Slack threads, and Circleback enrichment retain their necessary recovery state.

Update the ingestion authoring skill with the registry sync quality bar, provider capability selection, meaningful stream boundaries, existing pagination/checkpoint primitives, durable recovery rules, and required failure/restart verification.

Treat repeated pagination continuations as permanent provider-protocol errors so reader retries cannot repeatedly replay a cyclic collection.

Add per-integration changelog metadata, shown in registry inspection and integration guides. Keep one draft release per integration in each PR, refresh it in place until merge, and validate release artifacts against the PR base to protect published versions and changelog history.
