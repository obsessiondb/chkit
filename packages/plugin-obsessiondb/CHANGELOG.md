# @chkit/plugin-obsessiondb

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
