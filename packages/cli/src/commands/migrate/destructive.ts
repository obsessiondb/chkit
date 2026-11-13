import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  collectDestructiveOperationMarkers,
  collectUnmarkedDestructiveStatements,
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
    // Planner danger markers, plus destructive SQL at marker-less positions: a
    // fully hand-written migration, or a statement hand-appended to a generated
    // one. Planner-marked statements (incl. non-danger drops) are trusted and
    // not re-scanned.
    const found = [...collectDestructiveOperationMarkers(file, sql), ...collectUnmarkedDestructiveStatements(file, sql)]
    if (found.length === 0) continue
    migrations.push(file)
    operations.push(...found)
  }
  return { migrations, operations }
}
