---
"@chkit/core": patch
---

`importModuleFile` moved to the `@chkit/core/loader` subpath, so importing `@chkit/core` no longer pulls in the Node-only jiti loader.

- Breaking: import `importModuleFile` from `@chkit/core/loader` instead of `@chkit/core`.
