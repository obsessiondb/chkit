import { describe, expect, test } from 'bun:test'

import {
  type ClickHouseExecutor,
  createStatelessClickHouseExecutor,
} from './index.js'

type TransportRequest = { sql: string; url: URL; headers: Headers }

describe('query framed JSON transport', () => {
  test.each([
    ['one row without a trailing newline', envelope([{ id: 1 }]), [{ id: 1 }]],
    ['one row with a trailing newline', envelope([{ id: 1 }]) + '\n', [{ id: 1 }]],
    ['multiple rows without a trailing newline', envelope([{ id: 1 }, { id: 2 }]), [{ id: 1 }, { id: 2 }]],
    ['a genuine empty result', envelope([]), []],
  ])('decodes %s', async (_name, body, expected) => {
    await withTransport(() => new Response(body), async (executor) => {
      expect(await executor.query('SELECT id FROM app.events')).toEqual(expected)
      expect(await streamRows(executor, 'SELECT id FROM app.events')).toEqual(expected)
      expect((await executor.queryJson?.('SELECT id FROM app.events'))?.data).toEqual(expected)
    })
  })

  test('streams rows and characters split across response chunks', async () => {
    const chunks = ['{"meta":[],"data":[{"id":1,"name":"\xC3', '\xA9"},{"id":', '2},{"id":3}],"rows":3}']
    const reply = () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk, (char) => char.charCodeAt(0)))
        controller.close()
      },
    }))
    await withTransport(reply, async (executor) => {
      expect(await streamRows(executor, 'SELECT id, name FROM app.events')).toEqual([
        { id: 1, name: 'é' },
        { id: 2 },
        { id: 3 },
      ])
    })
  })

  test.each([
    ['a blank response', ''],
    ['a whitespace response', ' \n\t'],
    ['invalid JSON', 'not JSON'],
    ['a truncated row', '{"meta":[],"data":[{"id":'],
    ['a truncated envelope after a complete row', '{"meta":[],"data":[{"id":1}'],
    ['a missing row count', '{"meta":[],"data":[]}'],
    ['a mismatched row count', '{"meta":[],"data":[],"rows":1}'],
    ['a non-object data row', '{"meta":[],"data":[null],"rows":1}'],
    ['malformed column metadata', '{"meta":[{"name":"id"}],"data":[],"rows":0}'],
    ['non-JSON whitespace between rows', '{"meta":[],"data":[{"id":1}\v],"rows":1}'],
    ['a missing data array', '{"meta":[],"rows":0}'],
    ['a server exception after the envelope', envelope([]) + 'Code: 241. DB::Exception'],
  ])('rejects %s', async (_name, body) => {
    await withTransport(() => new Response(body), async (executor) => {
      await expect(executor.query('SELECT id FROM app.events')).rejects.toThrow()
      await expect(executor.queryJson?.('SELECT id FROM app.events')).rejects.toThrow()
      await expect(streamRows(executor, 'SELECT id FROM app.events')).rejects.toThrow()
      await expect(executor.queryControl?.('KILL QUERY WHERE query_id = \'old\' SYNC', 1000)).rejects.toThrow()
    })
  })

  test('accepts bodyless commands and queryJson DDL, including leading comments', async () => {
    await withTransport(() => new Response(''), async (executor) => {
      await executor.command('CREATE TABLE app.t (id UInt8) ENGINE = Memory')
      expect(await executor.query('\u00a0/* comment */ OPTIMIZE TABLE app.t\ufeff')).toEqual([])
      expect(await executor.queryControl?.('INSERT INTO app.t SELECT 1', 1000)).toEqual([])
      expect(await streamRows(executor, '\u00a0/* comment */ OPTIMIZE TABLE app.t\ufeff')).toEqual([])
      expect((await executor.queryJson?.('\u00a0/* comment */ OPTIMIZE TABLE app.t\ufeff'))?.data).toEqual([])
      expect((await executor.queryJson?.('EXCHANGE TABLES app.a AND app.b'))?.data).toEqual([])
      expect((await executor.queryJson?.('DELETE FROM app.t WHERE id = 0'))?.data).toEqual([])
      await expect(executor.queryJson?.('/* CREATE */ WITH 1 AS id SELECT id')).rejects.toThrow()
      await expect(executor.queryJson?.('EXPLAIN SELECT 1')).rejects.toThrow()
    })
  })

  test('does not turn a missing status response into unknown or finished', async () => {
    await withTransport(() => new Response(''), async (executor) => {
      await expect(executor.queryStatus('old', { runningOnly: true })).rejects.toThrow()
      await expect(executor.queryStatus('old')).rejects.toThrow()
    })
  })

  test('validates query-log responses after a genuine zero-row processes response', async () => {
    await withTransport((sql) => new Response(sql.includes('system.query_log') ? '' : envelope([])), async (executor) => {
      expect(await executor.queryStatus('old', { runningOnly: true })).toEqual({ status: 'unknown' })
      await expect(executor.queryStatus('old')).rejects.toThrow()
      expect(await executor.queryControl?.('KILL QUERY WHERE 0 SYNC', 1000)).toEqual([])
    })
  })

  test('keeps precision, nested arrays and escaped delimiters across single-byte chunks', async () => {
    const body = '{"meta":[{"name":"n","type":"UInt64"}],"data":[{"n":18446744073709551615,"nested":[{"s":"é}\\\"[,"}]}],"rows":1}'
    await withTransport(() => new Response(new ReadableStream({ start(controller) {
      for (const byte of new TextEncoder().encode(body)) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    } })), async (executor) => {
      const expected = [{ n: '18446744073709551615', nested: [{ s: 'é}"[,' }] }]
      expect(await executor.query('SELECT n')).toEqual(expected)
      expect(await streamRows(executor, 'SELECT n')).toEqual(expected)
    })
  })

  test('accepts a bodyless no-match KILL only with a final zero-row summary', async () => {
    await withTransport(() => new Response('', { headers: { 'x-clickhouse-summary': '{"result_rows":"0"}' } }), async (executor) => {
      expect(await executor.queryControl?.('KILL QUERY WHERE 0 SYNC', 1000)).toEqual([])
      expect(await executor.query('KILL QUERY WHERE 0 SYNC')).toEqual([])
      expect((await executor.queryJson?.('KILL QUERY WHERE 0 SYNC'))?.data).toEqual([])
      await expect(executor.query('SELECT id FROM app.events')).rejects.toThrow()
      await expect(executor.query('KILL QUERY WHERE 0 SYNC', { wait_end_of_query: 0 })).rejects.toThrow()
    })
  })

  test('retains headers and settings with framed JSON format, request headers and query settings', async () => {
    await withTransport(() => new Response(envelope([{ id: 1 }])), async (executor, requests) => {
      expect(await executor.query('SELECT id FROM app.events', { max_result_rows: 3 })).toEqual([{ id: 1 }])
      expect(await streamRows(executor, 'SELECT id FROM app.events;', { max_result_rows: 3 })).toEqual([{ id: 1 }])
      expect(requests).toHaveLength(2)
      for (const request of requests) {
        expect(request.sql).toContain('FORMAT JSON')
        expect(request.sql).not.toContain(';')
        expect(request.headers.get('X-DDL')).toBe('1')
        expect(request.url.searchParams.get('max_result_rows')).toBe('3')
        expect(request.url.searchParams.get('send_progress_in_http_headers')).toBe('1')
        expect(request.url.searchParams.get('http_headers_progress_interval_ms')).toBe('30000')
      }
    })
  })

  test('rejects HTTP 200 responses carrying a server exception header', async () => {
    await withTransport(() => new Response('{"id":1}\nCode: 241. DB::Exception: query failed', {
      headers: { 'x-clickhouse-exception-code': '241' },
    }), async (executor) => {
      await expect(executor.query('SELECT id FROM app.events')).rejects.toThrow('Code: 241.')
      await expect(streamRows(executor, 'SELECT id FROM app.events')).rejects.toThrow('Code: 241.')
    })
  })
})

async function streamRows(
  executor: ClickHouseExecutor,
  sql: string,
  settings?: Record<string, number>,
): Promise<unknown[]> {
  expect(executor.queryBatches).toBeDefined()
  const rows: unknown[] = []
  for await (const batch of executor.queryBatches?.<unknown>(sql, settings) ?? []) rows.push(...batch)
  return rows
}

async function withTransport(
  reply: (sql: string) => Response,
  check: (executor: ClickHouseExecutor, requests: TransportRequest[]) => Promise<void>,
): Promise<void> {
  const requests: TransportRequest[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const sql = await request.text()
      // The executor's once-per-executor readonly lookup (#412).
      if (sql.includes("getSetting('readonly')")) return new Response('{"readonly":"0"}\n')
      requests.push({ sql, url: new URL(request.url), headers: request.headers })
      return reply(sql)
    },
  })
  const executor = createStatelessClickHouseExecutor({ url: server.url.toString(), database: 'default' })
  try {
    await check(executor, requests)
  } finally {
    await executor.close()
    server.stop(true)
  }
}

function envelope(rows: unknown[]): string {
  return JSON.stringify({ meta: [{ name: 'id', type: 'UInt32' }], data: rows, rows: rows.length })
}
