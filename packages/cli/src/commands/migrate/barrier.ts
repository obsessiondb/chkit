import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { findNonSelectBarriers } from '../../runtime/safety-markers.js'
import { previewStatement } from './apply.js'
import type { PendingNonSelectBarrier } from './errors.js'

/**
 * The statements of pending migration files marked `mode=barrier` that are
 * not a SELECT (#634). Measured on the file, like the empty-migration check.
 */
export async function findPendingNonSelectBarriers(
  migrationsDir: string,
  pending: readonly string[],
): Promise<PendingNonSelectBarrier[]> {
  const perFile = await Promise.all(
    pending.map(async (migration) =>
      findNonSelectBarriers(await readFile(join(migrationsDir, migration), 'utf8')).map((barrier) => ({
        migration,
        statement: barrier.index + 1,
        total: barrier.total,
        operation: barrier.summary,
        preview: previewStatement(barrier.statement),
      })),
    ),
  )
  return perFile.flat()
}
