import { expect, test } from 'bun:test'

import { schema, table } from '@chkit/core'

import { generateIngestArtifacts } from '../index'

test('ingest helpers name every insertable column only for tables with EPHEMERAL inputs', () => {
  const definitions = schema(
    table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'raw', type: 'String', defaultKind: 'EPHEMERAL' },
        { name: 'shout', type: 'String', defaultKind: 'MATERIALIZED', default: 'fn:upper(raw)' },
        { name: "it's", type: 'String', default: 'fn:raw' },
      ],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    }),
    table({
      database: 'app',
      name: 'users',
      columns: [{ name: 'id', type: 'UInt64' }],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })
  )

  for (const [emitZod, values] of [[true, 'data'], [false, 'rows']] as const) {
    const { content } = generateIngestArtifacts({ definitions, options: { emitZod }, toolVersion: '0.1.0' })
    expect(content).toContain('compressed?: boolean; columns?: string[] }): Promise<void>')
    expect(content).toContain(
      `await ingestor.insert({ table: 'app.events', values: ${values}, columns: ['id', 'raw', '\`it\\'s\`'], compressed: options?.compressed ?? true })`
    )
    expect(content).toContain(
      `await ingestor.insert({ table: 'app.users', values: ${values}, compressed: options?.compressed ?? true })`
    )
  }
})
