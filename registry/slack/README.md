# Slack raw ingestion

This is editable source code: change the readers, schemas, and `pipeline.ts` directly. It uses the [chkit CLI](https://www.npmjs.com/package/chkit), `@chkit/core`, and `@chkit/plugin-ingest`; subsequent runs execute the installed code without contacting the registry.

## First run

Set `SLACK_API_TOKEN` in the execution environment and configure the project's direct ClickHouse connection. Native JSON requires ClickHouse 25.3 or newer. Review `config.ts` before generating the first migration; the default database is `default` and table names start with `slack_`.

### Create a Slack token

1. Create a Slack app for the intended workspace through [Slack app settings](https://docs.slack.dev/app-management/quickstart-app-settings/).
2. Open **OAuth & Permissions** and add **User Token Scopes** `channels:read`, `channels:history`, and `users:read` for the default public-channel integration. Add `users:read.email` if profile email addresses are needed.
3. Install or reinstall the app in the workspace and approve the requested scopes. Copy the **User OAuth Token** from **OAuth & Permissions**.
4. Set `SLACK_API_TOKEN` in the project's `.env` or the scheduler's secret environment.

User OAuth tokens are recommended for broad history and thread access. A bot may list public channels it has not joined, so select IDs of joined conversations rather than `channels: undefined`. Thread reads also require matching history scopes and conversation access; see [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/). An enabled thread permission failure fails the messages stream visibly. Fix token access or explicitly set `includeReplies: false` for history-only ingestion. See [Slack tokens](https://docs.slack.dev/authentication/tokens/).

Bun loads a project `.env`. A scheduler or other runtime must explicitly supply the variables. `.env.example` lists names and does not load credentials. Tokens are read when requests run; schema imports, `check`, migration generation, and `ingest list` make no Slack requests and need no token. The integration does not obtain or refresh OAuth credentials.

```sh
bunx chkit check
bunx chkit ingest list --tag provider:slack
bunx chkit generate --name add-slack
# Review the generated SQL.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:slack
```

Use an external scheduler to repeat ingestion, with one ingestion process per project and destination at a time.

## Included resources

All three streams read their complete selected resource on every run. Each discovers its own authenticated workspace through `auth.test`; the messages stream independently discovers conversations.

| Stream tag | Default raw table | Required scopes for defaults |
|---|---|---|
| `resource:channels` | `slack_channels_raw` | `channels:read` |
| `resource:users` | `slack_users_raw` | `users:read`; optional `users:read.email` |
| `resource:messages` | `slack_messages_raw` | `channels:read`, `channels:history` |

- **Channels:** conversation metadata returned by [`conversations.list`](https://docs.slack.dev/reference/methods/conversations.list/), including archived conversations when returned. No separate `conversations.info` expansion or membership request.
- **Users:** complete objects returned by [`users.list`](https://docs.slack.dev/reference/methods/users.list/), including profiles, bots, and deleted-user flags.
- **Messages:** all accessible retained [`conversations.history`](https://docs.slack.dev/reference/methods/conversations.history/) pages for selected conversations. With `includeReplies: true`, roots with `reply_count > 0` also fetch every `conversations.replies` page. Replies and their parents share the raw messages table.

Messages preserve blocks, attachments, reactions, metadata, and file references when returned. File references do not download files. No separate files, reactions, pins, canvases, search, or events reader is included.

## Choose conversations and request pacing

The default config selects public channels, includes replies, uses metadata pages of 200, and uses history/reply pages of 15. `requestIntervalMs` defaults to 3000; `messageIntervalMs` defaults to 60000.

Set `channels` to an array of Slack conversation IDs to restrict channels and messages. `undefined` selects all discovered conversations; `[]` selects none. Selection uses IDs, not names. A configured ID absent from discovery fails visibly. Users remain workspace-wide.

`conversationTypes` defaults to `['public_channel']`. Additional types require these read scopes and history scopes:

| Type | Discovery | History and replies |
|---|---|---|
| `public_channel` | `channels:read` | `channels:history` |
| `private_channel` | `groups:read` | `groups:history` |
| `im` | `im:read` | `im:history` |
| `mpim` | `mpim:read` | `mpim:history` |

Keep `sourceId` stable after ingestion begins. A second workspace should use a distinct source ID and a separate table prefix or database. Changing these values changes stream and storage identities and requires a deliberate migration.

Slack documents one request per minute and 15 objects per page for new commercially distributed apps outside the Slack Marketplace. Marketplace and internal customer-built apps retain Tier 3 limits. See the current [history method](https://docs.slack.dev/reference/methods/conversations.history/) and [rate-limit clarification](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/). For an internal app entitled to Tier 3, edit `messagePageSize` to 200 and `messageIntervalMs` to 1200 after confirming its limits.

The pipeline runs one stream, fetch, and load at a time. Requests have a 30-second timeout and use the ingestion executor's retry and cancellation context. The pipeline permits five retries after the initial attempt, with exponential backoff from 1 to 60 seconds. HTTP `429` honors `Retry-After`; Slack rate-limit responses and transient server codes also retry. Authentication and permission errors, including Slack `ok: false` responses, fail visibly instead of becoming empty datasets.

Full history and thread reads can take hours or days at the conservative defaults. Restrict conversations and selected streams, and choose `--max-duration` for the expected scan. The CLI's default duration is 3600 seconds. Interrupted runs restart their scans rather than resuming from a saved cursor.

To read only messages:

```sh
bunx chkit ingest run --tag provider:slack --tag resource:messages --max-duration 86400
```

## Stored data and identities

Every raw table contains stable `id`, native JSON `raw`, and chkit batch/run/ingestion-time columns. `raw` contains `source_id`, authenticated `team_id`, and the complete provider object under `data`. Messages also contain `channel_id`.

The row IDs are JSON-encoded arrays:

| Resource | Identity |
|---|---|
| Channels | `[sourceId, 'channels', teamId, conversation.id]` |
| Users | `[sourceId, 'users', teamId, user.id]` |
| Messages | `[sourceId, 'messages', teamId, channelId, message.ts]` |

Message timestamps remain strings. A parent returned by `conversations.replies` has the same identity as its history observation. Replies use their own timestamps; their `thread_ts` retains the root reference. Channel names, user emails, and message text are never keys.

The tables use `ReplacingMergeTree(_chkit_ingested_at)`. Later ingestion time wins; there is no Slack source-version ordering. Use `FINAL` for the latest observed row:

```sql
WITH toJSONString(raw) AS payload
SELECT
  JSONExtractString(payload, 'channel_id') AS channel_id,
  JSONExtractString(payload, 'data', 'ts') AS ts,
  JSONExtractString(payload, 'data', 'thread_ts') AS thread_ts,
  JSONExtractString(payload, 'data', 'user') AS user_id,
  JSONExtractString(payload, 'data', 'text') AS text
FROM default.slack_messages_raw FINAL
LIMIT 20;
```

There are no packaged typed views. Add SQL projections in the project's schema for the fields needed by the application. Preserve source and workspace identity in joins.

## Full reads and coverage limits

Each run starts at the beginning and reads history without date bounds or subtype filtering. Within each channel, history pagination finishes before threads are read. Old roots are scanned again to capture late replies when Slack still retains and exposes them. Short or empty pages continue when a cursor exists; repeated cursors or `has_more: true` without a cursor fail explicitly. Full reads save no incremental checkpoint.

The destination stores the latest **observed** payload per identity. Deleted messages, deselected conversations, and data made inaccessible remain in ClickHouse. Loaded batches stay visible when a run fails; there is no atomic snapshot replacement or rollback. Changes during pagination may cause misses or repeated observations. Slack retention, permissions, and token access determine historical coverage.

The integration has no deletion reconciliation, permanent edit log, webhooks, or continuous change capture. Date-range backfill flags do not make these readers bounded or incremental.

## Customize the source

`sources/channels.ts`, `sources/users.ts`, and `sources/messages.ts` each contain a resource's raw schema and reader. `client.ts` handles HTTP, authentication, validation, pagination, row IDs, and pacing; `pipeline.ts` composes the streams.

Remove a stream from `pipeline.ts` to stop ingestion while retaining its schema export in `index.ts` to preserve the table. Removing schema exports can generate destructive migration operations; review them. Test reader changes and revisit pacing when changing concurrency.

## Fixture tests

Install the optional portable test suite, then run it:

```sh
bunx chkit add slack --with-tests
bun test src/integrations/slack/tests/slack.test.ts
```

For a custom install path, point the command at its `tests/slack.test.ts`. Tests use sanitized responses, mocked HTTP, and in-memory ingestion destinations. They require Bun and no Slack credentials or ClickHouse server. Update fixtures and expectations alongside customized readers.

## Smoke check

After a migration and successful run, inspect `chkit ingest status --tag provider:slack` and query `SELECT count() FROM default.slack_messages_raw FINAL`. Compare a known message and an older thread with their stored payloads. Add a reply to that test thread, rerun ingestion, and verify the reply is collected. Row counts alone do not establish complete live API coverage.

The [Slack integration guide](https://chkit.obsessiondb.com/integrations/slack/) covers installation, SQL queries, scheduling, and recovery.
