import { BATCH_ID_COLUMN, INGESTED_AT_COLUMN, RUN_ID_COLUMN } from './destination.js'
import { IngestConfigError } from './errors.js'
import type { LoaderFactory } from './types.js'

export interface SimpleLoaderOptions {
  /** Rows per physical INSERT, a positive integer. A larger batch is split into deterministic chunks. */
  maxRowsPerInsert?: number
}

const DEFAULT_MAX_ROWS_PER_INSERT = 50_000

/**
 * Direct at-least-once destination writes. Every write unit reuses one stable
 * token across retries. The token names the batch and the unit's row range, so
 * a batch written by one INSERT has one token, a deterministically chunked
 * batch has one distinct token per chunk, and a replay sliced differently
 * (another `maxRowsPerInsert`) is re-inserted instead of being suppressed as a
 * duplicate of a token that covered other rows.
 */
export function simpleLoader(options: SimpleLoaderOptions = {}): LoaderFactory {
  const maxRows = options.maxRowsPerInsert ?? DEFAULT_MAX_ROWS_PER_INSERT
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new IngestConfigError('simpleLoader: maxRowsPerInsert must be a positive integer.')
  }

  return (ctx) => {
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
