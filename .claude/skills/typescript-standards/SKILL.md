---
name: typescript-standards
description: TypeScript coding standards for this monorepo. Use when writing/refactoring/reviewing TypeScript.
allowed-tools: [Read, Edit, Grep, Glob]
metadata:
  internal: true
---

# TypeScript Standards

## Named Exports Only

```ts
// Bad
export default function myFunction() {}

// Good
export function myFunction() {}
```

## Explicit Public Package Exports

Export only what other packages consume. Avoid wildcard exports for internal modules.

## Import Patterns

- Prefer static imports at file top
- Use dynamic imports only for real conditional loading or code splitting
- Use explicit type-only imports when importing types

```ts
import { type BuildOptions } from './types'
```

## Type Safety Rules

- Avoid `as`/double-cast assertions where possible
- Fix source types or introduce type guards instead
- Prefer discriminated unions for stateful workflows
- Prefer interfaces for extension-heavy compositions
- Avoid enums when `as const` objects are sufficient

## Async and Immutability

- Use `Promise.all` for independent parallel async operations
- Prefer immutable transforms over mutation

## Dependency Installation

Use Bun package manager commands in this repo:

```bash
bun add -d <package>
```
