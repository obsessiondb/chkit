import { describe, expect, test } from 'bun:test'

import {
  collectDefinitionsFromModule,
  schema,
  table,
  toCreateSQL,
  view,
} from './index'

describe('@chx/core smoke', () => {
  test('builds table and view definitions', () => {
    const users = table({
      database: 'app',
      name: 'users',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'email', type: 'String' },
      ],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const usersView = view({
      database: 'app',
      name: 'users_view',
      as: 'SELECT id, email FROM app.users',
    })

    const defs = schema(users, usersView)
    expect(defs).toHaveLength(2)
    expect(toCreateSQL(defs[0])).toContain('CREATE TABLE IF NOT EXISTS app.users')
  })

  test('collects and de-duplicates definitions from module exports', () => {
    const users = table({
      database: 'app',
      name: 'users',
      columns: [{ name: 'id', type: 'UInt64' }],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const defs = collectDefinitionsFromModule({
      one: users,
      two: [users],
    })

    expect(defs).toHaveLength(1)
  })
})
