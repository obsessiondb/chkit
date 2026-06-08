---
"chkit": patch
"@chkit/plugin-obsessiondb": patch
"@chkit/codegen": patch
---

Fix stale internal dependency pins in published packages. `chkit` shipped with `@chkit/plugin-obsessiondb` pinned one version behind because the publish step only resolved `workspace:` specifiers in `dependencies`/`devDependencies`, skipping `optionalDependencies` (where the plugin is declared) — so the CLI bundled an outdated plugin and every `chkit query` failed with `serviceSlug is required`.

The publish resolver now covers every dependency field, `@chkit/codegen` uses `workspace:*` for `@chkit/core` instead of an exact pin, and two release guards (source-side `check:workspace-deps` and packed-tarball `check:packed-deps`) fail the build if any publishable package would ship a stale or unresolved internal dependency.
