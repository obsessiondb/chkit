# Contributing

## Prerequisites

1. Bun `1.3.5`
2. Node.js `20+`

## Setup

```bash
bun install
```

## Daily Commands

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

## Changesets

Create a changeset for user-facing package changes:

```bash
bun run changeset
```

Apply version bumps:

```bash
bun run version-packages
```

## Pull Request Checklist

1. `bun run lint` passes.
2. `bun run typecheck` passes.
3. `bun run test` passes.
4. `bun run build` passes.
5. Include a changeset for package-impacting changes.
