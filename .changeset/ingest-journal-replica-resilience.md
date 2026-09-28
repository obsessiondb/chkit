---
"@chkit/plugin-ingest": patch
---

Harden the ingestion journal on replicated and managed ClickHouse (such as ObsessionDB). `ensure()` now waits until the journal table is visible after creating it. The run-level `run_started` and `run_finished` facts get the same bounded retry as stream facts, so one transient error, such as a lagging replica that doesn't know the journal table yet, no longer fails the whole run. Terminal facts (`work_finished`, `run_finished`) are no longer cut off after a fixed 5 seconds while the run is still live, so a slow but healthy journal write no longer turns a successful run into a `TimeoutError`. The 5-second grace still applies once a run is cancelled or its execution budget runs out.
