---
"@chkit/plugin-ingest": patch
---

`chkit ingest doctor` and `chkit ingest repair` stream the journal table instead of loading it whole, so their memory grows with the selected stream's history rather than with the whole journal.
