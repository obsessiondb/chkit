import { expect, test } from 'bun:test'

import { buildIntrospectedTables } from './index.js'

test('uses authoritative effective primary key when CREATE SQL omits its clause', () => {
  const [table] = buildIntrospectedTables([{
    database: 'app', name: 'events', engine: 'MergeTree', primary_key: 'user_id, id',
    create_table_query: 'CREATE TABLE app.events (id UInt64, user_id UInt64) ENGINE = MergeTree ORDER BY (user_id, id)',
  }], [], [])
  expect(table?.primaryKey).toBe('user_id, id')
})

test('preserves an explicit primary key distinct from sorting key', () => {
  const [table] = buildIntrospectedTables([{
    database: 'app', name: 'events', engine: 'MergeTree', primary_key: 'user_id',
    create_table_query: 'CREATE TABLE app.events (id UInt64, user_id UInt64) ENGINE = MergeTree PRIMARY KEY user_id ORDER BY (user_id, id)',
  }], [], [])
  expect(table?.primaryKey).toBe('user_id')
  expect(table?.orderBy).toBe('(user_id, id)')
})

test('does not synthesize a Kafka primary key', () => {
  const [table] = buildIntrospectedTables([{
    database: 'app', name: 'queue', engine: 'Kafka', primary_key: '',
    create_table_query: 'CREATE TABLE app.queue (id UInt64) ENGINE = Kafka SETTINGS kafka_topic_list = \'events\'',
  }], [], [])
  expect(table?.primaryKey).toBeUndefined()
  expect(table?.orderBy).toBeUndefined()
})
