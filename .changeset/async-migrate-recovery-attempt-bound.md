---
"chkit": patch
---

A re-run of `chkit migrate --apply` runs an async statement's `-- before-retry:` SQL only when the server rejected the attempt before it started, and runs the statement again only then or when the attempt was never sent; every attempt runs under a random query id recorded in the journal first, and a statement whose outcome cannot be told stops with `async_outcome_unknown`.

- Breaking: don't upgrade while an async migration is in progress, and add the journal's `operation_fingerprints` column with a user that can alter it before running async statements; a statement that failed while it ran, or that an earlier release left started or failed, now needs a reconcile and `--abandon` before it runs again.
