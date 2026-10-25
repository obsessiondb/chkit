import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'

import { fromPromise, runEffect } from '../../runtime/effect.js'
import { extractExecutableStatements } from '../../runtime/safety-markers.js'

/**
 * Pending migration files without an executable statement (only comments or
 * whitespace), such as a `generate --empty` stub that still waits for its SQL.
 * Measured on the file, before plugins see it: a plugin that removes every
 * statement does so on purpose.
 */
export function findEmptyMigrations(migrationsDir: string, pending: readonly string[]): Promise<string[]> {
  return runEffect(
    Effect.gen(function* () {
      const checks = yield* Effect.forEach(
        pending,
        (file) =>
          Effect.gen(function* () {
            const sql = yield* fromPromise(() => readFile(join(migrationsDir, file), 'utf8'))
            return {
              file,
              empty: extractExecutableStatements(sql).length === 0,
            }
          }),
        { concurrency: 'unbounded' },
      )
      return checks.filter((check) => check.empty).map((check) => check.file)
    }),
  )
}
