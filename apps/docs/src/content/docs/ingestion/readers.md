---
title: Readers and pagination
description: Fetch bounded pages, then add child collections and provider-specific behavior as needed.
---

A reader is an async generator that fetches provider data and yields bounded chunks shaped for its destination table.

## Requests and provider clients

Start with one HTTP request inside `context.attempt`. Pass its cancellation signal to `fetch`, and convert unsuccessful responses with `HttpError.fromResponse`. For a paginated endpoint, use `paginate({ context, fetchPage })`; it calls `context.attempt` for each page.

Authentication, token refresh, and required scopes belong to the provider client. Keep credentials in environment variables or the application's existing secret mechanism. Direct requests outside `context.attempt` bypass request-level retry policy and fetch permits.

## A reusable page client

This example assumes a provider contract: `GET /tickets` accepts `updated_since`, `updated_before`, and `cursor`, and returns `{ data: Ticket[], next_cursor: string | null }`. Replace the parameters and response parsing to match the provider's documentation. `HELPDESK_API_URL` is the API base URL, including a trailing slash; `HELPDESK_TOKEN` is its bearer token.

Create `src/sources/helpdesk-client.ts`:

```ts
import { HttpError } from '@chkit/plugin-ingest'

export type Ticket = { id: string; subject: string; updated_at: string }
export type TicketPage = { data: Ticket[]; next_cursor: string | null }

export async function fetchTicketPage(
  range: { from: Date; to: Date },
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<TicketPage> {
  const base = process.env.HELPDESK_API_URL
  const token = process.env.HELPDESK_TOKEN
  if (!base || !token) throw new Error('Set HELPDESK_API_URL and HELPDESK_TOKEN')
  const url = new URL('tickets', base)
  url.searchParams.set('updated_since', range.from.toISOString())
  url.searchParams.set('updated_before', range.to.toISOString())
  if (cursor !== undefined) url.searchParams.set('cursor', cursor)
  const response = await fetch(url, {
    signal,
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw await HttpError.fromResponse(response)
  return await response.json() as TicketPage
}
```

This helper performs one request. Call it through `context.attempt` or from `paginate`'s `fetchPage` callback, as shown in [Incremental syncs](/ingestion/incremental-syncs/#timestamp-windows). Validate untrusted response shapes at the source boundary in production; a TypeScript assertion does not validate JSON.

## Pagination is not a checkpoint

Use `paginate` when only the items matter. It supports an `initial` continuation, yields nonempty item arrays, and stops when `next` is `undefined` or `null`. It rejects repeated continuations to avoid infinite loops.

A page cursor can be temporary, tied to one snapshot, or expire before the next run. Only persist it with `cursorState` when the provider guarantees it is valid for later executions. Otherwise page through a timestamp window and commit progress after that whole window succeeds.

<details>
<summary>When a manual pagination loop is needed</summary>

Use a manual loop when page metadata must become a chunk `id` or durable `state`, or when an empty page carries meaningful progress. The helper yields item arrays, so it does not expose the returned continuation to the consumer or persist it as a checkpoint. Wrap each manual page request in `context.attempt`.

</details>

## Bound work and separate accounts

Yield pages as they arrive; do not collect a large source into one array. Source page size controls response memory; `batchSize` controls loading and is not a hard limit on a yielded chunk. See [Loading and batching](/ingestion/loading/).

Use stable stream IDs for independently resumable accounts or resources, for example `helpdesk.account-42.tickets`. The stream ID owns the checkpoint. If several accounts share a destination table, include account identity in the record key too; a provider-local ticket ID alone may collide.

## Parent records and child collections

For a document that needs a root object and its children, assemble one complete root in the reader:

1. Fetch a page of roots, such as tickets.
2. For each ticket, fetch every required comments page through `paginate` or `context.attempt`.
3. Attach the comments to the ticket and yield that object with `rawRows`, or map the assembled object into typed columns.

The default loader writes the assembled row. There is no automatic nested loader or parent/child registration. If a required child request fails, let the reader fail before yielding that root; do not publish a partial object as complete. Bound the assembled object size and report any provider-imposed truncation.

For separately queried children, load a `ticket_comments` table with its own stream, stable comment IDs, and a `ticket_id` column. A child stream can discover its own roots when the provider only exposes parent-scoped endpoints. It must not assume another stream has already loaded the parents: pipeline execution does not order dependencies. Choose the row model alongside [stored shape](/ingestion/destinations/#root-objects-and-related-tables).

:::caution[Child changes need a discovery path]
If editing or deleting a comment does not update the ticket's timestamp, an incremental ticket scan may never revisit it. Use a child change feed or an application-defined reconciliation scan. Handle [deleted records](/ingestion/destinations/#handle-deleted-records) explicitly.
:::

## Use an SDK when it helps

<details>
<summary>Wrap a provider SDK or reusable client</summary>

Use a provider SDK when it handles signing, authentication, or protocol details the integration needs. Call it inside `context.attempt`, forward cancellation where supported, and classify SDK-specific errors through the stream's `classifyError`. Avoid nested retries in the SDK and chkit unless their combined behavior is deliberate.

Pass `FetchContext` to reusable clients that need only `attempt` and `signal`; they do not need to depend on checkpoint types.

</details>

## Related pages

- [Incremental syncs](/ingestion/incremental-syncs/): choose the durable resume boundary.
- [Scheduling and recovery](/ingestion/operations/#retries-and-provider-errors): retry policies and provider error classification.
- [Test a source](/ingestion/testing/): check pagination and failure behavior with fixtures.
