---
"@chkit/plugin-backfill": patch
---

Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
