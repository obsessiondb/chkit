---
"chkit": patch
---

A re-run of `chkit migrate --apply` no longer records an interrupted async statement as completed from an earlier attempt's `system.query_log` entry that the interrupted run had ignored; it now reads the outcome with the same bound that run used, which the journal stores with the attempt.

- Breaking: finish async migrations interrupted under an earlier release before upgrading; this release stops with `async_outcome_unknown` on such a statement without `-- before-retry:` SQL and runs it again after that SQL otherwise, and an earlier release refuses to resume an async statement this release left running.
