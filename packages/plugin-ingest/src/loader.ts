import * as Effect from 'effect/Effect'

import { BATCH_ID_COLUMN, INGESTED_AT_COLUMN, RUN_ID_COLUMN } from './destination.js'
import { IngestConfigError } from './errors.js'
import { abortOn, foreign, runPublic, sync } from './runtime.js'
import type { LoaderFactory } from './types.js'

export interface SimpleLoaderOptions {
  /** Rows per physical INSERT. A larger batch is split into deterministic chunks. */
  maxRowsPerInsert?: number
}

const DEFAULT_MAX_ROWS_PER_INSERT = 50_000

/**
 * Direct at-least-once destination writes. Every write unit reuses one stable
 * token across retries: a batch written by one INSERT has one token, a
 * deterministically chunked batch has one distinct token per chunk.
 */
export function simpleLoader(options: SimpleLoaderOptions = {}): LoaderFactory {
  const maxRows = options.maxRowsPerInsert ?? DEFAULT_MAX_ROWS_PER_INSERT
  if (!Number.isSafeInteger(maxRows) || maxRows <= 0) throw new IngestConfigError('maxRowsPerInsert must be a positive finite safe integer.')

  return (ctx) => {
    let rows = 0
    let writeUnits = 0

    return {
      ctx,
      write(batch) {
        return runPublic(abortOn(Effect.gen(function* () {
          for (let offset = 0, unit = 0; offset < batch.rows.length; offset += maxRows, unit += 1) {
            yield* sync(() => ctx.signal.throwIfAborted())
            const slice = batch.rows.slice(offset, offset + maxRows).map((row) => {
              const { [INGESTED_AT_COLUMN]: _ignored, ...authored } = row
              return { ...authored, [BATCH_ID_COLUMN]: batch.batchId, [RUN_ID_COLUMN]: ctx.runId }
            })
            yield* foreign(() => ctx.destination.insert({ table: ctx.table, rows: slice, token: `${batch.batchId}:${unit}` }))
            yield* sync(() => ctx.signal.throwIfAborted())
            rows += slice.length
            writeUnits += 1
          }
        }), ctx.signal))
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
