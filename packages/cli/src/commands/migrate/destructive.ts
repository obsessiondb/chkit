import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import { fromPromise, runEffect } from '../../runtime/effect.js'

import {
  collectDestructiveOperationMarkers,
  collectUnmarkedDestructiveStatements,
  type DestructiveOperationMarker,
  migrationContainsDangerOperation,
  migrationContainsDestructiveSql,
} from '../../runtime/safety-markers.js'

export interface DestructiveScan {
  migrations: string[]
  operations: DestructiveOperationMarker[]
}

export function scanDestructive(migrationsDir: string, pending: string[]): Promise<DestructiveScan> {
  return runEffect(
    Effect.gen(function* () {
      const migrations: string[] = []
      const operations: DestructiveOperationMarker[] = []
      for (const file of pending) {
        const sql = yield* fromPromise(() => readFile(join(migrationsDir, file), 'utf8'))
        if (migrationContainsDangerOperation(sql)) {
          // Generated migration with planner risk markers (unchanged behavior).
          migrations.push(file)
          operations.push(...collectDestructiveOperationMarkers(file, sql))
        } else if (migrationContainsDestructiveSql(sql)) {
          // Destructive SQL at a marker-less position: a fully hand-written
          // migration, or a statement hand-appended to a generated one. Planner-
          // marked statements (incl. non-danger drops) are trusted and not re-scanned.
          migrations.push(file)
          operations.push(...collectUnmarkedDestructiveStatements(file, sql))
        }
      }
      return { migrations, operations }
    }),
  )
}
