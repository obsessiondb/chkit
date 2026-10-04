---
"chkit": patch
---

Allow registry resources to declare cursor checkpoints and timestamp windows alongside full scans. Upgrade the eight raw API integrations with provider-specific sync tokens, overlapping incremental ranges, and safe restart recovery, while preserving historical registry releases. Attio now creates independent configured object-type and list streams using existing full-sync pagination, with People and Companies enabled by default.

Update the ingestion authoring skill with the registry sync quality bar, provider capability selection, meaningful stream boundaries, existing pagination/checkpoint primitives, durable recovery rules, and required failure/restart verification.

Add per-integration changelog metadata, shown in registry inspection and integration guides. Keep one draft release per integration in each PR, refresh it in place until merge, and validate release artifacts against the PR base to protect published versions and changelog history.
