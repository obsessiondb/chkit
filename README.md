# chx

ClickHouse schema and migration toolkit for TypeScript projects.

This repository is a Turborepo + Bun monorepo scaffold with four packages:

- `@chx/core`: schema DSL, SQL generation, migration planning primitives.
- `@chx/clickhouse`: ClickHouse client adapter.
- `@chx/codegen`: snapshot + migration file generation.
- `@chx/cli`: `chx` command-line interface.

## Quick start

```bash
bun install
bun run build
bun run chx init
bun run chx generate --name init
```

## Monorepo scripts

- `bun run build`
- `bun run dev`
- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run chx <command>`
