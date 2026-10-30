---
"@chkit/plugin-backfill": patch
---

Escape backslashes, LIKE wildcards, and quotes in backfill query ID prefixes so resume reconciliation finds the literal plan's running and completed chunks without matching unrelated queries.
