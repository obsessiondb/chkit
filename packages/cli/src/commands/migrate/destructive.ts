import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  collectDestructiveOperationMarkers,
  collectUnmarkedDestructiveStatements,
  migrationContainsDangerOperation,
  migrationContainsDestructiveSql,
  migrationHasOperationMarkers,
  type DestructiveOperationMarker,
} from '../../runtime/safety-markers.js'

export interface DestructiveScan {
  migrations: string[]
  operations: DestructiveOperationMarker[]
}

export async function scanDestructive(
  migrationsDir: string,
  pending: string[],
): Promise<DestructiveScan> {
  const migrations: string[] = []
  const operations: DestructiveOperationMarker[] = []
  for (const file of pending) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    if (migrationContainsDangerOperation(sql)) {
      // Generated migration with planner risk markers (unchanged behavior).
      migrations.push(file)
      operations.push(...collectDestructiveOperationMarkers(file, sql))
    } else if (!migrationHasOperationMarkers(sql) && migrationContainsDestructiveSql(sql)) {
      // Fully hand-written migration (no planner markers) containing destructive
      // SQL. A generated migration always carries markers, so its planner risk
      // classification is trusted and not re-scanned here.
      migrations.push(file)
      operations.push(...collectUnmarkedDestructiveStatements(file, sql))
    }
  }
  return { migrations, operations }
}
