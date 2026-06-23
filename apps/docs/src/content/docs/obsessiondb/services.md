---
title: Services
description: List, select, alias, and override ObsessionDB services per command — and how queries route through the ObsessionDB API.
sidebar:
  order: 4
---

Once you're authenticated, the plugin manages which ObsessionDB service each command talks to. You set a default per project, override it per command, and define short aliases for the services you switch between most.

## List and select

List all services across the organizations your account belongs to:

```sh
chkit obsessiondb service list
```

Output is grouped by organization, with the currently selected service marked.

Pick one as the project default:

```sh
chkit obsessiondb service select
```

The selection is persisted to `.chkit/obsessiondb.json` next to your config file. Every `chkit` command after that uses it unless you override (see below).

Credentials and service selection live in separate files:

- **Credentials** — `~/.config/chkit/credentials.json`. The access token and API base URL, written by `login`/`signup` and shared across all projects.
- **Service selection and aliases** — `obsessiondb.json`. Stored per project at `.chkit/obsessiondb.json` (next to `clickhouse.config.ts`), or at `~/.config/chkit/obsessiondb.json` when running without a project config.

## Per-command override

Any command that hits ClickHouse accepts `--service <name-or-alias>` to target a different service for one invocation without changing the saved selection:

```sh
# Ad-hoc query against a different service
chkit query "SELECT count() FROM users" --service customer-b

# Apply migrations against a one-off service
chkit migrate --apply --service staging
```

`--service` is available on `generate`, `migrate`, `status`, `drift`, `check`, and `query`.

The lookup tries service names first (as shown in `chkit obsessiondb service list`), then saved aliases. If nothing matches, the command fails fast with the list of available services and aliases.

## Aliases

Aliases give your services short, memorable names. Set, list, and remove them with `service alias`:

```sh
# Define a short alias for a service
chkit obsessiondb service alias set prod customer-production

# Use the alias anywhere --service is accepted
chkit query "SELECT count() FROM users" --service prod

# List or remove aliases
chkit obsessiondb service alias list
chkit obsessiondb service alias remove prod
```

Project aliases live in `.chkit/obsessiondb.json`; profile-scoped aliases live in `~/.config/chkit/obsessiondb.json`. The project file wins when both define the same alias.

Aliases can't shadow real service names — if `prod` is already the name of a service, setting it as an alias is rejected.

## Remote query routing

When a service is selected, chkit doesn't open a direct ClickHouse connection. SQL from `chkit query` and any plugin command that runs queries is submitted through the ObsessionDB API to the selected service, and results are normalized back into chkit's executor interface.

This is why no `clickhouse` block is required in `clickhouse.config.ts` once you're authenticated — the plugin supplies the executor.

See [`chkit query`](/cli/query/) for the command reference, including the `--service` flag and JSON output.

## Related

- [`chkit query`](/cli/query/) — ad-hoc SQL execution against the selected service.
- [Engine Rewriting](/obsessiondb/engine-rewriting/) — how `Shared*` engines are handled depending on the active target.
- [Backfill Plugin](/plugins/backfill/) — backfills can submit jobs to ObsessionDB once a service is selected.
