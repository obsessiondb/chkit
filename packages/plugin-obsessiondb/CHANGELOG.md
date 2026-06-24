# @chkit/plugin-obsessiondb

## 0.1.0-beta.29

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- d9d5038: Polish error messages and a few noisy outputs:

  - A table defined with `orderBy` but no `primaryKey` no longer crashes with a raw `TypeError`; the primary key defaults to the order-by columns, matching ClickHouse.
  - Built-in command errors (e.g. a rejected migration) surface their own clean message instead of being wrapped in `Plugin "core" failed in ...`.
  - `chkit query` syntax errors no longer leak the injected `FORMAT JSON` clause the user never typed, and the "Expected one of" token dump is capped.
  - Connection errors whose reason is only in the message (no `.code`) — e.g. a typo'd host — are now recognized and cleaned instead of leaking the raw client string.
  - The post-apply message names the resolved journal table (respecting `CHKIT_JOURNAL_TABLE`) instead of a hardcoded `_chkit_migrations`.
  - The ObsessionDB "authenticated but no service selected" reminder is suppressed when a direct `clickhouse` target is configured (it was layered in from a global login, not chosen for the project).

- ca968d9: Fix stale internal dependency pins in published packages. `chkit` shipped with `@chkit/plugin-obsessiondb` pinned one version behind because the publish step only resolved `workspace:` specifiers in `dependencies`/`devDependencies`, skipping `optionalDependencies` (where the plugin is declared) — so the CLI bundled an outdated plugin and every `chkit query` failed with `serviceSlug is required`.

  The publish resolver now covers every dependency field, `@chkit/codegen` uses `workspace:*` for `@chkit/core` instead of an exact pin, and two release guards (source-side `check:workspace-deps` and packed-tarball `check:packed-deps`) fail the build if any publishable package would ship a stale or unresolved internal dependency.

- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- 99136de: Add ObsessionDB onboarding to `chkit init` and `create-chkit`: a 3-way "how do you want to connect?" prompt covering an existing ClickHouse instance, an existing ObsessionDB account, and claiming a free ObsessionDB dev instance. Adds passwordless CLI signup (`chkit obsessiondb signup`, email + one-time code) with automatic personal-org creation, and `chkit obsessiondb service claim` to claim and provision a free instance, then write a ready-to-use connection.

  Non-interactive callers (agents/CI) now get a full runbook instead of dead-end prompts: when no TTY is detected, onboarding prints every connect path as runnable commands, and `signup` supports a two-step OTP flow — `--request-only` sends the code and prints the exact follow-up command, then `--email --code <CODE>` verifies without re-sending (which would otherwise invalidate the code). When an explicit connect path is requested but cannot complete (e.g. `--connect claim` with no email, or a bad code), `chkit init` and `create-chkit` now exit non-zero instead of falling through to "next steps" with a success status, so scripts can detect the failure.

- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- 75bf348: Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

  Notes:

  - The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
  - The remote backfill flag `--service-id` is renamed to `--service-slug`.

- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- dfaa8fa: Consolidate all publishable packages on Zod 4. `@chkit/plugin-obsessiondb` was pinned to `zod@3.25.76` while the rest of the toolkit used Zod 4, pulling two major versions into the dependency tree; it now uses `zod@^4.3.6`. Its oRPC contracts are unaffected — `@orpc/contract` validates through the Standard Schema interface, which both Zod majors implement. `@chkit/plugin-codegen` now declares `zod` as a peer dependency (`^4.0.0`) instead of a direct dependency, so generated Zod schemas resolve against the consumer's own `zod` install rather than a bundled copy.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [f4e5a59]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [95e6dbb]
- Updated dependencies [ff1cd31]
- Updated dependencies [d9d5038]
- Updated dependencies [a94a2a1]
- Updated dependencies [17b8a27]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [8d5878a]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [5ee4afc]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [72c3fdd]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [0aa2c28]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.29
  - @chkit/clickhouse@0.1.0-beta.29

## 0.1.0-beta.28

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- ca968d9: Fix stale internal dependency pins in published packages. `chkit` shipped with `@chkit/plugin-obsessiondb` pinned one version behind because the publish step only resolved `workspace:` specifiers in `dependencies`/`devDependencies`, skipping `optionalDependencies` (where the plugin is declared) — so the CLI bundled an outdated plugin and every `chkit query` failed with `serviceSlug is required`.

  The publish resolver now covers every dependency field, `@chkit/codegen` uses `workspace:*` for `@chkit/core` instead of an exact pin, and two release guards (source-side `check:workspace-deps` and packed-tarball `check:packed-deps`) fail the build if any publishable package would ship a stale or unresolved internal dependency.

- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- 75bf348: Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

  Notes:

  - The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
  - The remote backfill flag `--service-id` is renamed to `--service-slug`.

- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [95e6dbb]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.28
  - @chkit/clickhouse@0.1.0-beta.28

## 0.1.0-beta.27

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- 75bf348: Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

  Notes:

  - The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
  - The remote backfill flag `--service-id` is renamed to `--service-slug`.

- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [95e6dbb]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.27
  - @chkit/clickhouse@0.1.0-beta.27

## 0.1.0-beta.26

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.26
  - @chkit/clickhouse@0.1.0-beta.26

## 0.1.0-beta.25

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.25
  - @chkit/clickhouse@0.1.0-beta.25

## 0.1.0-beta.24

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.24
  - @chkit/clickhouse@0.1.0-beta.24

## 0.1.0-beta.23

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `select-service`, or `--service` as appropriate.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.23
  - @chkit/clickhouse@0.1.0-beta.23

## 0.1.0-beta.22

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.22
  - @chkit/clickhouse@0.1.0-beta.22

## 0.1.0-beta.21

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.21
  - @chkit/clickhouse@0.1.0-beta.21

## 0.1.0-beta.20

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- f1066a6: Add device-code authentication (login/logout/whoami) and remote backfill routing via ObsessionDB backend.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.20

## 0.1.0-beta.19

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.19

## 0.1.0-beta.18

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.18

## 0.1.0-beta.17

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.17

## 0.1.0-beta.16

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- a52a2b2: Strip `storage_policy` setting from tables during local migrations (for non-ObsessionDB targets). Improves local development experience by removing cloud-only settings automatically.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.16

## 0.1.0-beta.15

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.15

## 0.1.0-beta.14

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.14

## 0.1.0-beta.13

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.13

## 0.1.0-beta.12

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.12

## 0.1.0-beta.11

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.11

## 0.1.0-beta.10

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.10

## 0.1.0-beta.9

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.9

## 0.1.0-beta.8

### Patch Changes

- a94a2a1: Add @chkit/plugin-obsessiondb for ObsessionDB engine compatibility.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.8
