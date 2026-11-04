import { BATCH_ID_COLUMN, INGESTED_AT_COLUMN, RUN_ID_COLUMN } from './destination.js'
import type { LoaderFactory } from './types.js'

export interface SimpleLoaderOptions {
  /** - Positive integer rows per physical INSERT; default 50,000. */
  maxRowsPerInsert?: number
}

const DEFAULT_MAX_ROWS_PER_INSERT = 50_000

/**
 * - Default cheap, direct, at-least-once appends; one stable retry token per write unit.
 * - Native dedup depends on engine settings and finite token retention, not row keys.
 *   Tokens include row ranges; reslicing may reinsert overlaps but cannot suppress unsaved rows.
 * - Choose stagedLoader for immutable-key dedup across overlaps/replays within its
 *   pinned-server/shared-executor/process contract; use a replacing-table/read model for updates.
 */
export function simpleLoader(options: SimpleLoaderOptions = {}): LoaderFactory {
  return (ctx) => {
    const maxRows = options.maxRowsPerInsert ?? DEFAULT_MAX_ROWS_PER_INSERT
    if (!Number.isInteger(maxRows) || maxRows <= 0) {
      throw new Error('simpleLoader: maxRowsPerInsert must be a positive integer.')
    }
    let rows = 0
    let writeUnits = 0

    return {
      ctx,
      async write(batch) {
        for (let offset = 0; offset < batch.rows.length; offset += maxRows) {
          ctx.signal.throwIfAborted()
          const slice = batch.rows.slice(offset, offset + maxRows).map((row) => {
            // Publication time is destination-owned: never let a mapped row supply it.
            const { [INGESTED_AT_COLUMN]: _ignored, ...authored } = row
            return { ...authored, [BATCH_ID_COLUMN]: batch.batchId, [RUN_ID_COLUMN]: ctx.runId }
          })
          await ctx.destination.insert({ table: ctx.table, rows: slice, token: `${batch.batchId}:${offset}-${offset + slice.length}` })
          rows += slice.length
          writeUnits += 1
        }
      },
      async finalize() {
        return { evidence: writeUnits === 0 ? 'none_required' : 'clickhouse_ack', rows, writeUnits }
      },
      async abort() {
        // Direct writes cannot be withdrawn; replay reuses the same tokens.
      },
    }
  }
}
