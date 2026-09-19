---
"chkit": patch
---

Keep polling an async data-load migration through transient gateway errors instead of aborting. A single HTTP 524 (or other transient failure) on a status-poll request no longer cancels the migration: the server-side query keeps running, so chkit tolerates a bounded number of poll errors and only gives up after the budget, with an explicit message that the load may still be running and that re-running re-attaches via the deterministic `query_id`. Only a real query exception, or a submit-time failure, is fatal. This affects only operations marked `mode=async` (data loads); ordinary schema DDL is synchronous and unaffected.
