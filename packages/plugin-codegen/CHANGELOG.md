# @chkit/plugin-codegen

## 0.1.2-beta.4

### Patch Changes

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.4
