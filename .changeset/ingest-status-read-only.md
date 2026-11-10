---
"@chkit/plugin-ingest": patch
---

`chkit ingest status` only reads, so read-only users can run it; without a journal table it reports `v0 (no checkpoint)` instead of creating one.
