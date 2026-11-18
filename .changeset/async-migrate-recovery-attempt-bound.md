---
"chkit": patch
---

An async statement's first attempt now runs under a random query id recorded in the journal before its submit, and a re-run reads only that id's outcome, so it never records the statement as completed from an earlier attempt's `system.query_log` entry. When the outcome cannot be told (no `query_log` entry, or a started record from an earlier release), `chkit migrate --apply` stops with `async_outcome_unknown` instead of running the statement again.

- Breaking: finish async migrations with the release that started them before upgrading; this release stops with `async_outcome_unknown` on a statement an earlier release left started, and an earlier release from #599 on refuses to resume one this release left started.
