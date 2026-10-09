import { IngestConfigError, paginate, type FetchContext, type TimestampRange } from '@chkit/plugin-ingest'

import { graphql, requireLinearObject, type LinearClientDeps, type LinearObject } from '../client.js'

/** A GraphQL page is one executor-owned attempt; cursors are local to this read. */
export function readLinearPages(context: FetchContext, input: {
  query: string
  select: (data: LinearObject) => unknown
  label: string
  variables?: Record<string, unknown>
  initial?: string
  window?: TimestampRange
}, deps: LinearClientDeps) {
  return paginate<LinearObject, string>({
    context, initial: input.initial, label: `POST /graphql ${input.label}`,
    fetchPage: async (after, signal) => {
      const data = await graphql(input.query, { ...input.variables, after: after ?? null }, signal, deps)
      const page = linearConnection(input.select(data), input.label)
      if (input.window) {
        for (const item of page.items) {
          const updated = typeof item.updatedAt === 'string' ? Date.parse(item.updatedAt) : NaN
          if (!Number.isFinite(updated) || updated < input.window.from.getTime() || updated > input.window.to.getTime()) {
            throw new IngestConfigError(`Linear ${input.label} has no updatedAt within the requested window.`)
          }
        }
      }
      return page
    },
  })
}

export function linearConnection(value: unknown, label: string) {
  const connection = requireLinearObject(value, `${label} connection`)
  if (!Array.isArray(connection.nodes)) throw new IngestConfigError(`Linear ${label} nodes is not an array.`)
  const items = connection.nodes.map((node: unknown) => {
    const item = requireLinearObject(node, `${label} node`)
    linearId(item)
    return item
  })
  const page = requireLinearObject(connection.pageInfo, `${label} pageInfo`)
  if (typeof page.hasNextPage !== 'boolean') throw new IngestConfigError(`Linear ${label} has no hasNextPage flag.`)
  if (!page.hasNextPage) return { items, next: undefined }
  if (typeof page.endCursor !== 'string' || !page.endCursor.trim()) {
    throw new IngestConfigError(`Linear ${label} returned no new cursor.`)
  }
  return { items, next: page.endCursor }
}

export function linearId(item: LinearObject): string {
  if (typeof item.id !== 'string' || !item.id.trim()) throw new IngestConfigError('Linear object has no valid ID.')
  return item.id
}
