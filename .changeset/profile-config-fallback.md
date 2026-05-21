---
"chkit": patch
"@chkit/plugin-obsessiondb": patch
---

Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `select-service`, or `--service` as appropriate.
