import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { __testUtils } from './migrate.js'

describe('migrate scoped selection', () => {
  test('includes unannotated migrations as safety fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-migrate-scope-'))
    try {
      await writeFile(
        join(dir, '001_unannotated.sql'),
        "ALTER TABLE app.events ADD COLUMN IF NOT EXISTS source String;"
      )
      await writeFile(
        join(dir, '002_annotated.sql'),
        [
          '-- operation: alter_table_add_column key=table:app.events:column:source risk=safe',
          "ALTER TABLE app.events ADD COLUMN IF NOT EXISTS source String;",
        ].join('\n')
      )

      const result = await __testUtils.filterPendingByScope(dir, ['001_unannotated.sql', '002_annotated.sql'], new Set(['app.events']))

      expect(result.files).toEqual(['001_unannotated.sql', '002_annotated.sql'])
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('001_unannotated.sql')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

