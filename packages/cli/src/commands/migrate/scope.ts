import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { extractMigrationOperationSummaries } from '../../runtime/safety-markers.js'
import {
  databaseKeyFromOperationKey,
  tableKeyFromOperationKey,
} from '../../runtime/table-scope.js'

export interface ScopeFilterResult {
  /** Migrations to apply under the scope (matched + fail-safe-included). */
  inScope: string[]
  /**
   * Migrations included because their target tables could NOT be determined
   * (no parseable `-- operation:` markers — e.g. hand-written migrations).
   * Surfaced to the caller so it can warn instead of silently skipping them.
   */
  undetermined: string[]
}

export async function filterPendingByScope(
  migrationsDir: string,
  pending: string[],
  selectedTables: ReadonlySet<string>,
): Promise<ScopeFilterResult> {
  const selectedDatabases = new Set(
    [...selectedTables].map((table) => table.split('.')[0] ?? ''),
  )

  const inScope: string[] = []
  const undetermined: string[] = []
  for (const file of pending) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    const operations = extractMigrationOperationSummaries(sql)

    // A migration with no parseable operation markers (a hand-written one) has
    // undeterminable target tables. Silently skipping it under --table is a
    // quiet correctness gap (#36): the user believes all pending work applied.
    // Fail-safe by including it, and report it so the caller can warn.
    if (operations.length === 0) {
      inScope.push(file)
      undetermined.push(file)
      continue
    }

    const matches = operations.some((operation) => {
      const tableKey = tableKeyFromOperationKey(operation.key)
      if (tableKey) return selectedTables.has(tableKey)

      const database = databaseKeyFromOperationKey(operation.key)
      if (database) return selectedDatabases.has(database)

      return false
    })

    if (matches) inScope.push(file)
  }

  return { inScope, undetermined }
}
