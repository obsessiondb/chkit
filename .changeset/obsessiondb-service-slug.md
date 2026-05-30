---
"chkit": patch
"@chkit/plugin-obsessiondb": patch
---

Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

Notes:

- The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
- The remote backfill flag `--service-id` is renamed to `--service-slug`.
