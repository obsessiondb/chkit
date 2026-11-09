import type { ClickHouseExecutor } from './index.js'

export interface IntrospectedDictionary {
  database: string
  name: string
  /** The `CREATE DICTIONARY` statement as ClickHouse stores it, with secrets shown as `[HIDDEN]`. */
  createQuery: string
}

interface SystemDictionaryRow {
  database: string
  name: string
  create_table_query: string
}

/**
 * The dictionaries in `databases`, with the statement ClickHouse stores for
 * each. Read from `system.tables`, not `system.dictionaries`: the latter shows
 * an empty source and layout until the dictionary first loads. A table with
 * `ENGINE = Dictionary(...)` has the same engine name and is left out.
 */
export async function listDictionaryDetails(
  executor: Pick<ClickHouseExecutor, 'query'>,
  databases: string[]
): Promise<IntrospectedDictionary[]> {
  if (databases.length === 0) return []
  const quotedDatabases = databases.map((db) => `'${db.replace(/'/g, "''")}'`).join(', ')
  const rows = await executor.query<SystemDictionaryRow>(
    `SELECT database, name, create_table_query
FROM system.tables
WHERE is_temporary = 0
  AND database IN (${quotedDatabases})
  AND engine = 'Dictionary'
  AND startsWith(create_table_query, 'CREATE DICTIONARY')`
  )
  return rows.map((row) => ({ database: row.database, name: row.name, createQuery: row.create_table_query }))
}
