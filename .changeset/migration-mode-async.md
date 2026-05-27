---
"chkit": patch
---

Add `mode=async` annotation for long-running migration operations.

Mark an operation as async by adding `mode=async` to its `-- operation:` header line, for example:

```sql
-- operation: load_table_data key=table:default.hits risk=caution mode=async
INSERT INTO default.hits SELECT * FROM s3(...);
```

When `chkit migrate --apply` encounters an async operation it:

1. Computes a deterministic `query_id` from `sha256(migration_filename + ':' + statement_index)`.
2. Checks `system.processes` / `system.query_log` for any prior attempt with that id.
3. Fires the INSERT via the existing `submit()` path without blocking on its HTTP response, and polls `queryStatus(query_id)` every 5 seconds — printing a one-line update (`written=N.NM rows (N.N GiB), elapsed Ns`) so the operator sees the load advance.
4. On `QueryFinish` → records the journal entry and proceeds. On `ExceptionWhileProcessing` → throws with the server's exception. On any prior run's failure → resubmits (retry semantics).

This unblocks two scenarios chkit could not previously handle:

- **Long INSERTs through a proxy/LB with an HTTP request-duration ceiling**: the operator sees progress, and a connection drop mid-poll no longer cancels the work — the deterministic id lets a re-run attach to the in-flight query on the server.
- **Transient client-side errors during a multi-minute load**: re-running chkit picks up where it left off rather than starting over.

Existing migrations without `mode=async` continue to use the synchronous path; the annotation is opt-in and forward-compatible (an unknown mode value falls back to sync).
