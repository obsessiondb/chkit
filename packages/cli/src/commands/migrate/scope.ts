import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { extractMigrationOperationSummaries } from '../../runtime/safety-markers.js'
import {
  databaseKeyFromOperationKey,
  tableKeyFromOperationKey,
} from '../../runtime/table-scope.js'

export async function filterPendingByScope(
  migrationsDir: string,
  pending: string[],
  selectedTables: ReadonlySet<string>,
): Promise<string[]> {
  const selectedDatabases = new Set(
    [...selectedTables].map((table) => table.split('.')[0] ?? ''),
  )

  const inScope: string[] = []
  for (const file of pending) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    const operations = extractMigrationOperationSummaries(sql)
    const matches = operations.some((operation) => {
      const tableKey = tableKeyFromOperationKey(operation.key)
      if (tableKey) return selectedTables.has(tableKey)

      const database = databaseKeyFromOperationKey(operation.key)
      if (database) return selectedDatabases.has(database)

      return false
    })

    if (matches) inScope.push(file)
  }

  return inScope
}
