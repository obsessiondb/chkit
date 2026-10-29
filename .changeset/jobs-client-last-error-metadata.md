---
"@chkit/plugin-obsessiondb": patch
---

The jobs returned by the exported `JobsClient` now type `lastError` and `metadata` on every job, including `list`, matching the jobs API (#327).
