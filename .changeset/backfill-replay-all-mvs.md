---
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

Fix `backfill` mv_replay so it rebuilds **every** materialized view feeding the target table, not just the first. ClickHouse allows several MVs to share one destination table; previously only the first-declared MV was replayed and the rest were silently dropped, leaving the backfill incomplete. Each chunk now runs one `INSERT INTO target … SELECT … UNION ALL SELECT …` covering all matching MVs, so a single query id and idempotency token still cover the chunk. Single-MV plans are unchanged.
