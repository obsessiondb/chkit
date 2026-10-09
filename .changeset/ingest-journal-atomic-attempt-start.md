---
"@chkit/plugin-ingest": patch
---

Write a newly planned unit of work and its first attempt to the ingestion journal in one atomic insert, which cuts one journal insert per stream run. `Journal.append` now takes an array of events, and a custom journal must write the whole array atomically.
