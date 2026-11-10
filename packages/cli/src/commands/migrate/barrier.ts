import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { extractExecutableStatements, extractMigrationOperationSummaries } from '../../runtime/safety-markers.js'
import { nonSelectBarriers } from './apply.js'
import type { PendingNonSelectBarrier } from './errors.js'

/**
 * The statements of pending migration files marked `mode=barrier` that are
 * not a SELECT (#634). Measured on the file, like the empty-migration check;
 * apply checks the statements again after the plugins.
 */
export async function findPendingNonSelectBarriers(
  migrationsDir: string,
  pending: readonly string[],
): Promise<PendingNonSelectBarrier[]> {
  const perFile = await Promise.all(
    pending.map(async (migration) => {
      const sql = await readFile(join(migrationsDir, migration), 'utf8')
      return nonSelectBarriers(migration, extractExecutableStatements(sql), extractMigrationOperationSummaries(sql))
    }),
  )
  return perFile.flat()
}
