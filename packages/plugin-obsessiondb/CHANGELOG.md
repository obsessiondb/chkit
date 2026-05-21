# @chkit/plugin-obsessiondb

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
