---
title: Getting Started with ObsessionDB
description: Connect chkit to ObsessionDB from the CLI — claim a free dev instance, sign up with a one-time email code, or log in to an existing account.
sidebar:
  order: 2
---

Connect chkit to ObsessionDB without copying URLs or tokens by hand: scaffold a project and pick a connection in one prompt, or sign up and claim a free dev instance straight from the CLI.

## Connect in one step

When you scaffold a project with `bun create chkit@latest` or run `chkit init` in an existing one, chkit asks how you want to connect:

```
Claim a free ObsessionDB dev instance   email code, ready in seconds
I already have an ObsessionDB account    log in and pick a service
I already have a ClickHouse instance     connect with env vars
Configure later
```

- **Claim a free dev instance** signs you up with a one-time email code, creates a personal organization, provisions a free instance, and writes the selected service to `.chkit/obsessiondb.json`.
- **Existing ObsessionDB account** logs in and lets you pick a service.
- **Existing ClickHouse instance** prints the environment variables to set.

Preselect a path with `--connect <claim|account|clickhouse|later>` to skip the prompt — useful in scripts and non-interactive runs (see [Non-interactive setup](#non-interactive-setup)).

The rest of this page covers each path as standalone CLI commands, which is also what you run when adding ObsessionDB to a project that already exists.

## Install the plugin

```sh
bun add -d @chkit/plugin-obsessiondb
```

Register it in your `clickhouse.config.ts`:

```ts
import { defineConfig } from '@chkit/core'
import { obsessiondb } from '@chkit/plugin-obsessiondb'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [obsessiondb()],
})
```

You don't need a `clickhouse` block — once a service is selected, the plugin routes SQL through the ObsessionDB API.

## Sign up from the CLI

`chkit obsessiondb signup` is passwordless. It prompts for your email, sends a 6-digit code, and verifies it:

```sh
chkit obsessiondb signup
```

On first signup it creates a personal organization automatically. Returning users are logged straight in. Credentials are stored locally under `~/.config/chkit/` so subsequent commands don't re-prompt.

| Flag | Type | Description |
|------|------|-------------|
| `--email` | string | Email to sign up / log in with (skips the prompt). |
| `--code` | string | One-time code (skips the prompt). Its presence verifies without re-sending a code. |
| `--request-only` | boolean | Only send the code and print the follow-up command (step 1 of 2). |
| `--org-name` | string | Override the auto-created organization name. |
| `--api-url` | string | ObsessionDB API base URL, for non-default regions. |

## Claim a free instance

Once signed in, claim and provision a free dev instance:

```sh
chkit obsessiondb service claim
```

This checks eligibility, claims an instance, and polls until it reports `running` (up to a few minutes). The claimed service is written to `.chkit/obsessiondb.json` and becomes the default target. If your organization has already claimed its free instance, the command lists existing instances so you can select one instead.

## Already have an account

Log in with the browser device-code flow instead of signing up:

```sh
chkit obsessiondb login
```

Verify the login:

```sh
chkit obsessiondb whoami
```

If you're on a non-default ObsessionDB region, pass `--api-url` to `login`. See [Services](/obsessiondb/services/) for credential storage details and how to switch regions.

## Select a service

If you didn't claim an instance during signup, list services across the organizations you belong to and pick one:

```sh
chkit obsessiondb service list
chkit obsessiondb service select
```

The selection is written to `.chkit/obsessiondb.json` next to your config file and becomes the default target for every `chkit` command after that.

## Run your first command

Confirm the routing works:

```sh
chkit query "SELECT 1"
```

The query goes through the ObsessionDB API to your selected service. If it returns a row, you're done — your schema commands (`generate`, `migrate`, `status`, `drift`, `check`) use the same target from here on.

## Non-interactive setup

In CI, containers, and agent runs there's no TTY to prompt against. `chkit init`, `create-chkit`, and `chkit obsessiondb signup` adapt instead of dead-ending.

### Runbook on no TTY

When no TTY is detected and `--connect` isn't given, onboarding prints every connect path as runnable commands rather than blocking on a prompt:

```
No TTY detected — connect a database non-interactively by running one of these:

  • Free ObsessionDB dev instance (2 steps, needs the emailed code):
      chkit obsessiondb signup --email <you@example.com>
      chkit obsessiondb signup --email <you@example.com> --code <CODE>
      chkit obsessiondb service claim

  • Existing ObsessionDB account:
      chkit obsessiondb login

  • Existing ClickHouse instance:
      set CLICKHOUSE_URL (and CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DB)
```

### Two-step OTP signup

Signing up needs a code from your inbox, so the CLI splits it into two commands. Step one sends the code; step two verifies it. Passing `--code` skips re-sending — requesting a new code would invalidate the one you received.

```sh
# Step 1 — send the code (does not sign in)
chkit obsessiondb signup --email you@example.com --request-only

# Step 2 — verify with the emailed code (does not re-send)
chkit obsessiondb signup --email you@example.com --code 123456

# Then claim a free instance
chkit obsessiondb service claim
```

### Exit codes

When an explicit connect path is requested but can't complete — for example `--connect claim` with no email, or a wrong code — `chkit init` and `create-chkit` exit non-zero instead of falling through to "next steps" with a success status, so scripts can detect the failure.

## Next

- [Engine Rewriting](/obsessiondb/engine-rewriting/) — what the plugin does to `Shared*` engines when you also target regular ClickHouse.
- [Services](/obsessiondb/services/) — managing multiple services, per-command overrides, and aliases.
