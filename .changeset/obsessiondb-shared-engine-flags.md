---
"@chkit/plugin-obsessiondb": patch
---

Fix `--force-shared-engines` and `--no-shared-engines`. The plugin looked the parsed flags up without their `--` prefix, so both overrides were silently ignored and host auto-detection always decided whether the `storage_policy` table setting was stripped. `--force-shared-engines` now keeps it for a URL not recognized as ObsessionDB (for example a service behind a custom domain), and `--no-shared-engines` strips it even when targeting ObsessionDB. The flags take effect in `chkit generate` and `chkit snapshot rebuild`, which now accepts them too, so a rebuilt snapshot matches what `generate` writes; `migrate`, `status`, `drift` and `check` still accept them but ignore them. The flag help no longer claims to keep `Shared` engines, and the docs now state that chkit writes the standard engine name (`SharedMergeTree` becomes `MergeTree()`) for every target while the plugin only strips `storage_policy`.
