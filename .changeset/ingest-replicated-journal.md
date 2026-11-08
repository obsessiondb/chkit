---
"@chkit/plugin-ingest": patch
---

With `clickhouse.cluster` set, `chkit ingest run` creates its journal as one `ReplicatedMergeTree` on every replica and refuses to run on a journal that is not.

- Breaking: on a cluster, a local journal an earlier version created now fails `ingest run`; copy its rows into a replicated journal and set `journalTable` to it.
