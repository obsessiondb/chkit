import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { createStatelessClickHouseExecutor, isSendNotAdmitted, type ClickHouseExecutor } from './index.js'

// A stand-in for ClickHouse's HTTP interface that records each request's
// query_id and answers it at once, as a finished command.
let server: http.Server
const received: string[] = []
let url = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(new URL(req.url ?? '/', 'http://localhost').searchParams.get('query_id') ?? '')
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'X-ClickHouse-Summary': '{}' })
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function executor(): ClickHouseExecutor {
  return createStatelessClickHouseExecutor({ url, username: 'default', password: '', database: 'default' })
}

describe('submit with an admission (#765)', () => {
  test('sends the request once the admission admits it', async () => {
    const db = executor()

    await db.submit('INSERT INTO t SELECT 1', 'admitted-1', undefined, { admit: () => true })

    expect(received).toContain('admitted-1')
    expect(db.submitSendsOnce).toBe(true)
    await db.close()
  })

  test('sends nothing, and rejects, when the admission refuses', async () => {
    const db = executor()

    const error = await db.submit('INSERT INTO t SELECT 1', 'refused-1', undefined, { admit: () => false }).catch((e: unknown) => e)

    expect(isSendNotAdmitted(error)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).not.toContain('refused-1')
    await db.close()
  })

  // The driver yields (sleep(0)) between submit() and the request's creation.
  // A stop that lands in that gap must still keep the request from starting.
  test('asks the admission when the driver creates the request, after it yields', async () => {
    const db = executor()
    let stopped = false
    let asked = 0

    const sending = db.submit('INSERT INTO t SELECT 1', 'stopped-in-gap-1', undefined, {
      admit: () => {
        asked++
        return !stopped
      },
    })
    expect(asked).toBe(0)
    stopped = true
    const error = await sending.catch((e: unknown) => e)

    expect(asked).toBe(1)
    expect(isSendNotAdmitted(error)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).not.toContain('stopped-in-gap-1')
    await db.close()
  })
})
