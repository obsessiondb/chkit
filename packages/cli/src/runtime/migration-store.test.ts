import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listMigrations } from './migration-store.js'

describe('listMigrations', () => {
  // #703: a bare sort() compares UTF-16 units and lists U+1F600 (a surrogate
  // pair) before U+FF5E; chkit-py lists migrations by code point.
  test('orders migration files by code point', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-migration-order-'))
    try {
      const emoji = '20260101000000_a\u{1F600}.sql'
      const fullwidth = '20260101000000_a～.sql'
      await writeFile(join(dir, emoji), '')
      await writeFile(join(dir, fullwidth), '')
      expect(await listMigrations(dir)).toEqual([fullwidth, emoji])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
