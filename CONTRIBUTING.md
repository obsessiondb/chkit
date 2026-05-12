# Contributing

Thanks for considering a contribution. chkit is a young project — bug reports, docs PRs, and small fixes are especially welcome.

## Prerequisites

- Bun `1.3.5+`
- Node.js `20+`

## Setup

```bash
git clone https://github.com/obsessiondb/chkit
cd chkit
bun install
```

## Development

```bash
bun run typecheck    # type-check all packages
bun run lint         # lint all packages
bun run test         # run unit tests
bun run build        # build all packages
```

E2E tests run against a live ClickHouse instance and require `CLICKHOUSE_HOST` (or `CLICKHOUSE_URL`) and `CLICKHOUSE_PASSWORD` to be set. See [CLAUDE.md](CLAUDE.md#testing) for the full list.

## Pull requests

- Branch off `main`, PR back to `main`.
- Keep PRs focused on one logical change.
- Run a changeset for any user-facing package change:

  ```bash
  bun run changeset
  ```

- `typecheck`, `lint`, `test`, and `build` must all pass.
- Commit messages are free-form. Changesets capture the user-facing narrative.

## Plugins

Plugins live in `packages/plugin-*`. The official plugins are the reference — `codegen`, `pull`, `backfill`, and `obsessiondb` each show a different hook surface. The simplest starting point is to copy one and adapt it.

## Reporting issues

- Bugs and feature requests → [GitHub Issues](https://github.com/obsessiondb/chkit/issues).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
