import { schema, table } from '@chkit/core'

const users = table({
  database: 'default',
  name: 'users',
  engine: 'MergeTree',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'email', type: 'String' },
    { name: 'created_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
  ],
  primaryKey: ['id'],
  orderBy: ['id'],
})

const events = table({
  database: 'default',
  name: 'events',
  engine: 'MergeTree',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'user_id', type: 'UInt64' },
    { name: 'name', type: 'String' },
    { name: 'created_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
  ],
  primaryKey: ['id'],
  orderBy: ['id'],
})

export default schema(users, events)
