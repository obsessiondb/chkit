---
"chkit": patch
"@chkit/clickhouse": patch
"@chkit/plugin-obsessiondb": patch
---

On multi-replica targets such as multi-replica ObsessionDB services, async `migrate` checks every replica for a running attempt, so it no longer resubmits a statement or runs its `-- before-retry:` SQL while an earlier attempt is still writing (#246). Async statements sent through ObsessionDB now run under chkit's query id, so status checks and re-runs can find them.
