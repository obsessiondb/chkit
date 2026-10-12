---
title: "chkit init"
description: "Scaffold a chkit project — config, example schema, dependencies, and an optional database connection."
sidebar:
  order: 2
---

Scaffolds a chkit project in the current directory: writes a `clickhouse.config.ts` and an example schema file, installs dependencies if the project has none, and — on an interactive run — offers to connect a database.

## Synopsis

```
chkit init [flags]
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--connect <choice>` | string | — | Preselect a connection path: `claim`, `account`, `clickhouse`, or `later`. Skips the interactive prompt. |
| `--email <email>` | string | — | Email for the ObsessionDB `claim` / `account` paths (implies an interactive connect step). |
| `--code <code>` | string | — | One-time email code, to verify a signup without re-prompting. |
| `--org-name <name>` | string | — | Override the auto-created ObsessionDB organization name. |
| `--help`, `-h` | boolean | `false` | Print help without writing files, installing packages or connecting. |
| `--yes`, `-y` | boolean | `false` | Skip the connect prompt and just write files — keeps `init` a silent scaffolder for scripts. |

See [global flags](/cli/overview/#global-flags).

## Behavior

`chkit init` runs three steps in order. Each is idempotent, so re-running on an existing project is safe.

### 1. Scaffold files

Writes two files relative to the current working directory, leaving any that already exist untouched:

1. **`clickhouse.config.ts`** — project config with sensible defaults: `schema: './src/db/schema/**/*.ts'`, `outDir: './chkit'`, `migrationsDir: './chkit/migrations'`, `metaDir: './chkit/meta'`, an empty `plugins` array, and a `clickhouse` block enabled when `CLICKHOUSE_URL` is supplied. A direct connection requires explicit `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` (intentionally empty is allowed), and `CLICKHOUSE_DB`; optional `CLICKHOUSE_CLUSTER` preserves cluster DDL metadata. Supplied target metadata remains available during offline generation. Without a URL, a registered provider plugin may supply the connection instead.
2. **`src/db/schema/example.ts`** — a starter `MergeTree` table named `events` with columns `id` (`UInt64`), `source` (`String`), and `ingested_at` (`DateTime64(3)`, default expression `now64(3)`). The schema requires `CLICKHOUSE_DB` before generation; it does not invent a database namespace.

Under [chkit-py](/python/overview/), the same command writes `clickhouse.config.py` and `src/db/schema/example.py` instead.

### 2. Install dependencies

If `@chkit/core` does not already resolve from the project, `init` makes the project runnable: it writes a minimal `package.json` when none exists, then installs `chkit`, `@chkit/core`, and `@chkit/plugin-obsessiondb` as dev dependencies using the detected package manager (`npm`, `pnpm`, `yarn`, or `bun`; defaults to `bun`). This is why `init` works in a brand-new empty folder, not just an existing project. A failed install never aborts `init` — it prints the manual install command and continues.

### 3. Connect a database

On a TTY — or when `--connect` / `--email` is passed — `init` runs the ObsessionDB onboarding prompt:

```
Claim a free ObsessionDB dev instance   email code, ready in seconds
I already have an ObsessionDB account    log in and pick a service
I already have a ClickHouse instance     connect with env vars
Configure later
```

Claiming or logging in registers the `@chkit/plugin-obsessiondb` plugin in your config and writes the selected service to `.chkit/obsessiondb.json`. See [Getting Started with ObsessionDB](/obsessiondb/getting-started/) for each path in detail, including the non-interactive and agent-friendly (`--json`) variants.

Pass `--yes` to skip this step and just write files. Without a TTY or explicit connect flags, the onboarding flow prints its non-interactive runbook. For offline work, set the intended `CLICKHOUSE_DB`, edit the schema and generate; obtain the remaining connection values before any connected command. When an explicit connect path is requested but cannot complete — for example `--connect claim` with no email, or a wrong code — `init` exits non-zero so scripts can detect the failure.

## Examples

**Scaffold and connect interactively:**

```sh
chkit init
```

**Scaffold only, no prompt (CI / scripts):**

```sh
chkit init --yes
# Set CLICKHOUSE_DB to the namespace you intend to manage before generate.
```

**Preselect the claim path (still prompts for the emailed code):**

```sh
chkit init --connect claim --email you@example.com
```

For a fully scripted claim with no prompts, use the two-step OTP flow in [Getting Started with ObsessionDB](/obsessiondb/getting-started/#non-interactive-setup).

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| non-zero | An explicitly requested connect path could not complete |

## Related commands

- [Getting Started: add to an existing project](/getting-started/add-to-existing-project/) — the guided first-run flow
- [Getting Started with ObsessionDB](/obsessiondb/getting-started/) — every connect path in detail
- [`chkit generate`](/cli/generate/) — generate migrations from your schema after init
