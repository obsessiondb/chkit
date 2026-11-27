import { expect, test } from 'bun:test'
import { createStatelessClickHouseExecutor } from '@chkit/clickhouse'

import { createClickHouseJournal, emptyCheckpoint } from './journal.js'
import { doctorJournal } from './recovery.js'

for (const readonly of [0, 1, 2]) {
  test.each(['', ' \n', '{"meta":[],"data":[', 'not JSON', '{"meta":[],"data":[],"rows":0}'])(
    `checkpoint read with readonly=${readonly} validates its envelope: %j`, async (body) => {
      const statements: string[] = []
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const sql = await request.text()
          if (sql.includes("getSetting('readonly')")) return new Response(`{"readonly":"${readonly}"}\n`)
          statements.push(sql)
          return new Response(body)
        },
      })
      const executor = createStatelessClickHouseExecutor({ url: server.url.toString(), database: 'default' })
      const journal = createClickHouseJournal({ executor, database: 'default', targetId: 'target' })
      try {
        if (body.includes('"rows":0')) expect(await journal.readCheckpoint('stream')).toEqual(emptyCheckpoint())
        else await expect(journal.readCheckpoint('stream')).rejects.toThrow()
        expect(statements).toHaveLength(1)
        expect(statements[0]).toContain('FORMAT JSONStrings')
      } finally {
        await executor.close()
        server.stop(true)
      }
    },
  )
}

test('recovery rejects a blank journal stream after a valid framed count', async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const sql = await request.text()
      if (sql.includes("getSetting('readonly')")) return new Response('{"readonly":"0"}\n')
      if (sql.includes('system.tables')) return Response.json({ data: [{ x: '1' }], rows: 1 })
      if (sql.includes('count()')) return Response.json({ data: [{ rows: '1' }], rows: 1 })
      return new Response('')
    },
  })
  const executor = createStatelessClickHouseExecutor({ url: server.url.toString(), database: 'default' })
  try {
    await expect(doctorJournal('stream', { executor, database: 'default', targetId: 'target' })).rejects.toThrow('the response was incomplete')
  } finally {
    await executor.close()
    server.stop(true)
  }
})
