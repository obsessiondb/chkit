---
"@chkit/plugin-ingest": patch
---

Each ingestion run now journals its `run_started` and `run_finished` facts under its own `@run:<run id>` namespace. Previously every run shared one `@run` namespace, so two executor processes that overlapped once (for example a local run during a scheduled one) left conflicting facts at the same sequence number and every later run refused to start. Stream checkpoints were never affected; per-stream namespaces still detect overlap.
