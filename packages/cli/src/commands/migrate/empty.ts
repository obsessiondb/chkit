import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { extractExecutableStatements } from '../../runtime/safety-markers.js'

/**
 * Pending migration files without an executable statement (only comments or
 * whitespace), such as a `generate --empty` stub that still waits for its SQL.
 * Measured on the file, before plugins see it: a plugin that removes every
 * statement does so on purpose.
 */
export async function findEmptyMigrations(
  migrationsDir: string,
  pending: readonly string[],
): Promise<string[]> {
  const checks = await Promise.all(
    pending.map(async (file) => ({
      file,
      empty: extractExecutableStatements(await readFile(join(migrationsDir, file), 'utf8')).length === 0,
    })),
  )
  return checks.filter((check) => check.empty).map((check) => check.file)
}
