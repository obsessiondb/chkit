---
"chkit": patch
---

A re-run of `chkit migrate --apply` no longer runs an async statement again, or its `-- before-retry:` SQL, unless the server recorded the attempt's failure: every attempt runs under a random query id recorded in the journal first, and a statement whose outcome cannot be told stops with `async_outcome_unknown`.

- Breaking: don't upgrade while an async migration is in progress, and add the journal's `operation_fingerprints` column with a user that can alter it before running async statements; this release stops with `async_outcome_unknown` on a statement an earlier release left started or failed, and with `async_attempt_unfenced` when the column is missing.
