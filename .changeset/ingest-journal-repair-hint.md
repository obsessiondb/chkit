---
"@chkit/plugin-ingest": patch
---

When two runs claim the same journal sequence numbers, the journal error now names the run to keep and prints the `DELETE` statement that removes the later run's facts.
