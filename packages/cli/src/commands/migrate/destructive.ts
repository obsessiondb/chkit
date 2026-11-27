import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  collectDestructiveOperations,
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
    const found = collectDestructiveOperations(file, sql)
    if (found.length === 0) continue
    migrations.push(file)
    operations.push(...found)
  }
  return { migrations, operations }
}
