`generate` no longer fails on a refreshable materialized view without `APPEND` that
targets a `Replicated*` table, as in TS. ObsessionDB, ClickHouse Cloud and `Replicated`
databases accept replace-mode refreshes, so chkit now only warns that a non-replicated
(`Atomic`) database refuses them.
