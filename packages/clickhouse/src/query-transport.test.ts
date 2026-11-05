import { describe, expect, test } from 'bun:test'

import {
  type ClickHouseExecutor,
  createStatelessClickHouseExecutor,
} from './index.js'

type TransportRequest = { sql: string; url: URL; headers: Headers }

describe('query JSONEachRow transport', () => {
  test.each([
    ['one row without a trailing newline', '{"id":1}', [{ id: 1 }]],
    ['one row with a trailing newline', '{"id":1}\n', [{ id: 1 }]],
    ['multiple rows without a trailing newline', '{"id":1}\n{"id":2}', [{ id: 1 }, { id: 2 }]],
    ['multiple rows with a trailing newline', '{"id":1}\n{"id":2}\n', [{ id: 1 }, { id: 2 }]],
    ['an empty result', '', []],
    ['whitespace-only lines', ' \t\r\n\n ', []],
    ['blank lines between rows', '\n{"id":1}\n \t\n{"id":2}\n\n', [{ id: 1 }, { id: 2 }]],
    ['CRLF-delimited rows', '{"id":1}\r\n{"id":2}\r\n', [{ id: 1 }, { id: 2 }]],
  ])('decodes %s', async (_name, body, expected) => {
    await withTransport(() => new Response(body), async (executor) => {
      expect(await executor.query('SELECT id FROM app.events')).toEqual(expected)
      expect(await streamRows(executor, 'SELECT id FROM app.events')).toEqual(expected)
    })
  })

  test('streams rows and characters split across response chunks', async () => {
    const chunks = ['{"id":1,"name":"\xC3', '\xA9"}\n{"id":', '2}\n{"id":3}']
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
    ['an invalid only row', 'not JSON'],
    ['an invalid final row without a newline', '{"id":1}\n{"id":'],
    ['an invalid final row with a newline', '{"id":1}\n{"id":\n'],
    ['a nonempty exception line', '{"id":1}\nCode: 241. DB::Exception: query failed'],
  ])('rejects %s', async (_name, body) => {
    await withTransport(() => new Response(body), async (executor) => {
      await expect(executor.query('SELECT id FROM app.events')).rejects.toBeInstanceOf(SyntaxError)
      await expect(streamRows(executor, 'SELECT id FROM app.events')).rejects.toBeInstanceOf(SyntaxError)
    })
  })

  test('retains JSONEachRow format, request headers and query settings', async () => {
    await withTransport(() => new Response('{"id":1}'), async (executor, requests) => {
      expect(await executor.query('SELECT id FROM app.events', { max_result_rows: 3 })).toEqual([{ id: 1 }])
      expect(await streamRows(executor, 'SELECT id FROM app.events;', { max_result_rows: 3 })).toEqual([{ id: 1 }])
      expect(requests).toHaveLength(2)
      for (const request of requests) {
        expect(request.sql).toContain('FORMAT JSONEachRow')
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
  for await (const batch of executor.queryBatches!<unknown>(sql, settings)) rows.push(...batch)
  return rows
}

async function withTransport(
  reply: () => Response,
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
      return reply()
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
