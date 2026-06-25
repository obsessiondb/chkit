---
"chkit": patch
---

`chkit init` now auto-installs `chkit`, `@chkit/core`, and `@chkit/plugin-obsessiondb` when the project has no dependencies, so a fresh `init` into an empty directory produces a runnable project instead of dead-ending on unresolved config imports at the first `generate`. Detects the package manager from `npm_config_user_agent` (defaults to bun), writes a minimal `package.json` if absent, and degrades to printing the manual install command if the install fails.
