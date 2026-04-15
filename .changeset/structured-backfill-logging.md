---
"chkit": patch
"@chkit/plugin-backfill": patch
---

Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
