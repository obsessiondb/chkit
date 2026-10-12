import { expect, test } from 'bun:test'

import { canonicalizeDefinition, table, toCreateSQL } from './index.js'

test('an omitted input primaryKey uses ClickHouse implicit ORDER BY semantics', () => {
  const definition = table({
    database: 'app', name: 'events', engine: 'MergeTree',
    columns: [{ name: 'id', type: 'UInt64' }], orderBy: ['id'],
  })
  const resolved = canonicalizeDefinition(definition)
  expect(resolved.kind === 'table' && resolved.primaryKey).toEqual(['id'])
  expect(toCreateSQL(definition)).toContain('PRIMARY KEY (`id`)')
  expect(toCreateSQL(definition)).toContain('ORDER BY (`id`)')
})
