import { schema, table } from '@chkit/core'

const events = table({
  database: 'default',
  name: 'events',
  engine: 'MergeTree',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'source', type: 'String' },
    { name: 'ingested_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
  ],
  primaryKey: ['id'],
  orderBy: ['id'],
  partitionBy: 'toYYYYMM(ingested_at)',
})

export default schema(events)
