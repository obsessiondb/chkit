import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  collectDestructiveOperationMarkers,
  migrationContainsDangerOperation,
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
      migrations.push(file)
      operations.push(...collectDestructiveOperationMarkers(file, sql))
    }
  }
  return { migrations, operations }
}
