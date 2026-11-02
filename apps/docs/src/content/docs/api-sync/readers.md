---
title: Readers and pagination
description: Fetch bounded pages, then add child collections and provider-specific behavior as needed.
---

A reader is an async generator that fetches provider data and yields bounded chunks shaped for its destination table.

## Requests and provider clients

Send requests with `context.fetch`. It takes a fetch permit, retries only transient failures with backoff and `Retry-After`, aborts when the run is cancelled or after 30 seconds, and throws `HttpError` for unsuccessful responses. For a paginated endpoint, use `paginate({ context, fetchPage })`; a `context.fetch` inside `fetchPage` shares that page's attempt, so it is retried once per page, never twice.

Keep everything that touches HTTP in one provider client: configuration, credentials, URLs, authentication headers, pagination, and response parsing. Build the client at the start of `read`. Schema commands such as `generate` and `migrate` import the same module, but never run a reader, so they need neither credentials nor valid sync settings. A missing credential or an invalid setting fails that stream before its first request and is not retried. Readers then only call client methods and turn provider objects into chunks.

Use `context.attempt` for source operations that are not plain HTTP requests, such as an SDK call. Requests made with the global `fetch` bypass the request queue and retries, so any failure there fails the stream. See [retry boundaries](/api-sync/operations/#retry-boundaries).

## A reusable page client

This example assumes a provider contract: `GET /tickets` accepts `updated_since`, `updated_before`, and `cursor`, and returns `{ data: Ticket[], next_cursor: string | null }`. Replace the parameters and response parsing to match the provider's documentation. `HELPDESK_API_URL` is the API base URL, including a trailing slash; `HELPDESK_TOKEN` is its bearer token.

Create `src/sources/helpdesk-client.ts`:

```ts
import { paginate, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

export const helpdeskConfig = {
  baseUrl: process.env.HELPDESK_API_URL,
  token: process.env.HELPDESK_TOKEN,
}

const configSchema = z.object({
  baseUrl: z.url({ error: 'Set HELPDESK_API_URL.' }),
  token: z.string({ error: 'Set HELPDESK_TOKEN.' }).min(1, 'Set HELPDESK_TOKEN.'),
})
const ticketPage = z.object({
  data: z.array(z.looseObject({ id: z.string(), updated_at: z.string() })),
  next_cursor: z.string().nullable(),
})

export function createHelpdeskClient(context: SourceContext, config = helpdeskConfig) {
  const { baseUrl, token } = configSchema.parse(config)
  return {
    tickets: (range: { from: Date; to: Date }) => paginate({
      context,
      label: 'GET /tickets',
      fetchPage: async (cursor: string | undefined) => {
        const url = new URL('tickets', baseUrl)
        url.searchParams.set('updated_since', range.from.toISOString())
        url.searchParams.set('updated_before', range.to.toISOString())
        if (cursor !== undefined) url.searchParams.set('cursor', cursor)
        const response = await context.fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        const page = ticketPage.parse(await response.json())
        return { items: page.data, next: page.next_cursor ?? undefined }
      },
    }),
  }
}
```

The reader in [Incremental syncs](/api-sync/incremental-syncs/#timestamp-windows) builds this client and iterates `client.tickets(context.selection)`. The zod schemas validate the untrusted response; a TypeScript assertion does not validate JSON. A validation error fails the stream without retries. `z.looseObject` keeps every provider field for the raw destination. A second account passes its own `config` to `createHelpdeskClient`.

## Pages and checkpoint metadata

`paginate` yields the complete `{ items, next, metadata? }` returned by `fetchPage`, including empty and terminal pages. Read rows from `page.items`. `initial` and `next` support offset, string-token, and compound-object continuations, compared by their JSON serialization (a `bigint` continuation is rejected); `next: undefined` ends pagination. At runtime, an omitted or `null` continuation also ends pagination. Repeated continuations, including a return to `initial`, and a result that is not a page object with an `items` array fail the stream before the invalid page reaches the reader.

`next` controls the next request. `metadata` carries provider details such as a candidate checkpoint, replacement sync token, or page identity. The helper preserves metadata without interpreting or persisting it. With `cursorState`, explicitly map a safe, complete checkpoint from the page into `SourceChunk.state`; the executor commits it after the rows are saved. Empty pages can carry meaningful progress through the same path. See the complete [provider cursor example](/api-sync/incremental-syncs/#provider-cursors-and-compound-state).

A page cursor can be temporary, tied to one snapshot, or expire before the next run. Only persist it with `cursorState` when the provider guarantees it is valid for later executions. Otherwise page through a timestamp window and commit progress after that whole window succeeds.

For a sync-token API, a nonterminal page can retain the input sync token and save its next-page position in metadata. Its terminal page has no `next`, but can carry a replacement sync token. Metadata and pagination therefore have independent types: `paginate<TItem, TCursor, TMetadata>`. Protocol-specific token recovery remains the client's responsibility. A rejected token usually arrives as an unsuccessful response: catch the `HttpError` from `context.fetch`, check its `status` and `body`, and return a reset page instead of throwing.

## Bound work and separate accounts

Yield pages as they arrive; do not collect a large source into one array. Source page size controls response memory; `batchSize` controls loading and is not a hard limit on a yielded chunk. See [Loading and batching](/api-sync/loading/).

Use stable stream IDs for independently resumable accounts or resources, for example `helpdesk.account-42.tickets`. The stream ID owns the checkpoint. If several accounts share a destination table, include account identity in the record key too; a provider-local ticket ID alone may collide.

## Parent records and child collections

For a document that needs a root object and its children, assemble one complete root in the reader:

1. Fetch a page of roots, such as tickets.
2. For each ticket, fetch every required comments page through `paginate` or `context.attempt`.
3. Attach the comments to the ticket and yield that object with `rawRows`, or map the assembled object into typed columns.

The default loader writes the assembled row. There is no automatic nested loader or parent/child registration. If a required child request fails, let the reader fail before yielding that root; do not publish a partial object as complete. Bound the assembled object size and report any provider-imposed truncation.

For separately queried children, load a `ticket_comments` table with its own stream, stable comment IDs, and a `ticket_id` column. A child stream can discover its own roots when the provider only exposes parent-scoped endpoints. It must not assume another stream has already loaded the parents: pipeline execution does not order dependencies. Choose the row model alongside [stored shape](/api-sync/destinations/#root-objects-and-related-tables).

:::caution[Child changes need a discovery path]
If editing or deleting a comment does not update the ticket's timestamp, an incremental ticket scan may never revisit it. Use a child change feed or an application-defined reconciliation scan. Handle [deleted records](/api-sync/destinations/#handle-deleted-records) explicitly.
:::

## Use an SDK when it helps

<details>
<summary>Wrap a provider SDK or reusable client</summary>

Use a provider SDK when it handles signing, authentication, or protocol details the integration needs. Call it inside `context.attempt`, forward cancellation where supported, and classify SDK-specific errors through the stream's `classifyError`. Avoid nested retries in the SDK and chkit unless their combined behavior is deliberate.

Pass `SourceContext` to reusable clients; it carries `fetch`, `attempt`, and `signal`, without checkpoint types.

</details>

## Related pages

- [Incremental syncs](/api-sync/incremental-syncs/): choose the durable resume boundary.
- [Scheduling and recovery](/api-sync/operations/#retries-and-provider-errors): retry policies and provider error classification.
- [Test a source](/api-sync/testing/): check pagination and failure behavior with fixtures.
