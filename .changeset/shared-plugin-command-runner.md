---
"@chkit/core": patch
"@chkit/plugin-backfill": patch
"@chkit/plugin-codegen": patch
"@chkit/plugin-pull": patch
---

Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
