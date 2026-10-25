import * as Effect from 'effect/Effect'
import { fromPromise } from '../effect-runtime.js'
import {
  describeSqlContext,
  describeSqlOperation,
  getBackfillLogger,
  SLOW_CLICKHOUSE_QUERY_MS,
  SLOW_CLICKHOUSE_QUERY_REPEAT_INITIAL_MS,
  SLOW_CLICKHOUSE_QUERY_REPEAT_MAX_MS,
  summarizeSql,
} from '../logging.js'
import type { GenerateChunkPlanInput } from './types.js'

const queryLogger = getBackfillLogger('chunking', 'clickhouse')

export function timedPlannerQuery<T>(
  input: Pick<GenerateChunkPlanInput, 'database' | 'table' | 'query'>,
  sql: string,
  settings?: Record<string, string | number | boolean | undefined>,
): Effect.Effect<T[], unknown> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const sqlSummary = summarizeSql(sql)
    const operation = describeSqlOperation(sql)
    const context = describeSqlContext(sql)
    const queryLabel = context ? `${operation} (${context})` : operation
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Effect.sleep(SLOW_CLICKHOUSE_QUERY_MS)
            queryLogger.warning(
              `clickhouse query still running for ${input.database}.${input.table} after ${Math.round(performance.now() - startedAt)}ms: ${queryLabel} | ${sqlSummary}`,
            )
            let repeatDelayMs = SLOW_CLICKHOUSE_QUERY_REPEAT_INITIAL_MS
            while (true) {
              yield* Effect.sleep(repeatDelayMs)
              queryLogger.warning(
                `clickhouse query still running for ${input.database}.${input.table} after ${Math.round(performance.now() - startedAt)}ms: ${queryLabel}`,
              )
              repeatDelayMs = Math.min(repeatDelayMs * 2, SLOW_CLICKHOUSE_QUERY_REPEAT_MAX_MS)
            }
          }),
        )

        queryLogger.debug(`clickhouse query started for ${input.database}.${input.table}: ${sqlSummary}`)

        const rows = yield* fromPromise(() => input.query<T>(sql, settings)).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              queryLogger.error(
                `clickhouse query failed for ${input.database}.${input.table} after ${Math.round(performance.now() - startedAt)}ms: ${sqlSummary}`,
              )
            }),
          ),
        )
        const durationMs = Math.round(performance.now() - startedAt)
        if (durationMs >= SLOW_CLICKHOUSE_QUERY_MS) {
          queryLogger.debug(
            `slow clickhouse query completed for ${input.database}.${input.table} in ${durationMs}ms (${rows.length} rows): ${queryLabel}`,
          )
        } else {
          queryLogger.debug(
            `clickhouse query completed for ${input.database}.${input.table} in ${durationMs}ms (${rows.length} rows): ${sqlSummary}`,
          )
        }
        return rows
      }),
    )
  })
}
