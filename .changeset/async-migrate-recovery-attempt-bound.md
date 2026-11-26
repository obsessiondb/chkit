---
"chkit": patch
---

`migrate --apply` locks the journal, stops retries if ownership is lost, and recovers completed async attempts without replaying them; it retries only unsent attempts or SELECT/INSERT statements rejected before execution, limits `-- before-retry:` SQL to those rejected statements, and stops uncertain outcomes with `async_outcome_unknown`. `--retry` rejects edits to completed statements, polling errors retain submit failures, and stopped locks can be recovered after heartbeat expiry or with `--break-lock`.

- Breaking: don't upgrade while an async migration is in progress, and add the journal's `operation_fingerprints` column with a user that can alter it before running async statements; a statement that failed while it ran, or that an earlier release left started or failed, now needs a reconcile and `--abandon` before it runs again.
