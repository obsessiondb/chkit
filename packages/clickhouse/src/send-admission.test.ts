import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'

import { createStatelessClickHouseExecutor, isSendNotAdmitted, type ClickHouseExecutor } from './index.js'
import { acquireSendSlot, createAdmissionAgent, createSendQueue, urlConnectionOptions } from './send-admission.js'

// A stand-in for ClickHouse's HTTP interface that records each request's
// query_id and answers it, after `answerAfterMs`, as a finished command.
let server: http.Server
const received: string[] = []
let url = ''
let inFlight = 0
let peakInFlight = 0
let answerAfterMs = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(new URL(req.url ?? '/', 'http://localhost').searchParams.get('query_id') ?? '')
    inFlight++
    peakInFlight = Math.max(peakInFlight, inFlight)
    req.resume()
    req.on('end', () => {
      setTimeout(() => {
        inFlight--
        res.writeHead(200, { 'X-ClickHouse-Summary': '{}' })
        res.end()
      }, answerAfterMs)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function executor(target = url): ClickHouseExecutor {
  return createStatelessClickHouseExecutor({ url: target, username: 'default', password: '', database: 'default' })
}

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
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

// The admission agent replaces the one @clickhouse/client builds, so it reads
// clickhouse.url's connection options with the driver's rules.
describe('urlConnectionOptions', () => {
  test('keeps the driver defaults: keep-alive on, 10 connections', () => {
    expect(urlConnectionOptions('http://localhost:8123')).toEqual({ keepAlive: true, maxOpenConnections: 10 })
  })

  test('reads booleans and limits as the driver does', () => {
    expect(urlConnectionOptions('http://h/?keep_alive_enabled=0&max_open_connections=1.5')).toEqual({ keepAlive: false, maxOpenConnections: 1.5 })
    expect(urlConnectionOptions('http://h/?keep_alive_enabled=1&max_open_connections=3')).toEqual({ keepAlive: true, maxOpenConnections: 3 })
    expect(() => urlConnectionOptions('http://h/?keep_alive_enabled=yes')).toThrow('"keep_alive_enabled" has invalid boolean value: yes')
    expect(() => urlConnectionOptions('http://h/?max_open_connections=0')).toThrow('"max_open_connections" value 0 is less than min allowed 1')
  })

  test('the agent leaves the connection limit to the send queue', () => {
    const agent = createAdmissionAgent('https://ch.example.com:8443/?max_open_connections=3&keep_alive_enabled=false', new Map())

    expect(agent).toBeInstanceOf(https.Agent)
    expect(agent.maxSockets).toBe(Number.POSITIVE_INFINITY)
    expect((agent as unknown as { keepAlive: boolean }).keepAlive).toBe(false)
    agent.destroy()
  })
})

// Round 5: the refusal is the submit's own record, so a socket error the
// driver sees for the destroyed request cannot hide it.
describe('a refused submit stays refused', () => {
  test('against an endpoint that refuses connections (a cold socket)', async () => {
    const db = executor(`http://127.0.0.1:${await closedPort()}`)

    const error = await db.submit('INSERT INTO t SELECT 1', 'refused-cold-1', undefined, { admit: () => false }).catch((e: unknown) => e)

    expect(isSendNotAdmitted(error)).toBe(true)
    await db.close()
  })

  test('on a reused keep-alive socket', async () => {
    const db = executor()
    await db.submit('INSERT INTO t SELECT 1', 'warm-1', undefined, { admit: () => true })

    const error = await db.submit('INSERT INTO t SELECT 1', 'refused-warm-1', undefined, { admit: () => false }).catch((e: unknown) => e)

    expect(isSendNotAdmitted(error)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).not.toContain('refused-warm-1')
    await db.close()
  })

  test('keeps the socket limit of clickhouse.url: excess submits queue', async () => {
    const db = executor(`${url}/?max_open_connections=1`)
    answerAfterMs = 100
    peakInFlight = 0

    await Promise.all([1, 2, 3].map((n) => db.submit('INSERT INTO t SELECT 1', `capped-${n}`, undefined, { admit: () => true })))

    answerAfterMs = 0
    expect(received).toEqual(expect.arrayContaining(['capped-1', 'capped-2', 'capped-3']))
    expect(peakInFlight).toBe(1)
    await db.close()
  })

  // The same checks under Node, which the published CLI runs on.
  test('under Node: a cold refusal stays refused, and the URL options read the same', async () => {
    const dist = new URL('../dist/index.js', import.meta.url).pathname
    const agentModule = new URL('../dist/send-admission.js', import.meta.url).pathname
    const script = `
      const { createStatelessClickHouseExecutor, isSendNotAdmitted } = await import(${JSON.stringify(dist)})
      const { urlConnectionOptions } = await import(${JSON.stringify(agentModule)})
      const db = createStatelessClickHouseExecutor({ url: 'http://127.0.0.1:${await closedPort()}', username: 'default', password: '', database: 'default' })
      const error = await db.submit('INSERT INTO t SELECT 1', 'refused-node-1', undefined, { admit: () => false }).catch((e) => e)
      await db.close()
      const options = urlConnectionOptions('https://h/?max_open_connections=1.5&keep_alive_enabled=0')
      console.log(JSON.stringify({ refused: isSendNotAdmitted(error), options }))
    `
    const node = spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' })

    expect(node.stderr).toBe('')
    expect(JSON.parse(node.stdout.trim())).toEqual({ refused: true, options: { keepAlive: false, maxOpenConnections: 1.5 } })
  })
})

// Round 6: submits wait for a connection slot in chkit's queue, never in the
// agent's, so a stop refuses a waiting submit before it reaches the agent.
describe('createSendQueue', () => {
  test('refuses a waiting submit when its signal aborts, and never hands it a slot', async () => {
    const queue = createSendQueue(1)
    const first = await queue.acquire()
    const stop = new AbortController()

    const waiting = queue.acquire(stop.signal).then(() => 'slot', (error: unknown) => error)
    stop.abort()
    const outcome = await waiting
    first()

    expect(isSendNotAdmitted(outcome)).toBe(true)
    // The slot freed by the first goes to the next waiter, not the refused one.
    const next = await queue.acquire()
    next()
  })

  test('a submit with an aborted signal never waits', async () => {
    const stop = new AbortController()
    stop.abort()

    await expect(createSendQueue(5).acquire(stop.signal)).rejects.toThrow('The request was not sent')
  })
})

// Round 7: the queue grants a slot and drops its abort listener a turn before
// the waiting submit resumes. A stop in that turn still refuses the submit,
// before the driver, and the slot goes back.
describe('acquireSendSlot at the grant-versus-abort boundary', () => {
  test('under Bun: a stop between the grant and the resumption refuses and frees the slot', async () => {
    const queue = createSendQueue(1)
    const first = await queue.acquire()
    const stop = new AbortController()

    const waiting = acquireSendSlot(queue, stop.signal).then(() => 'slot', (error: unknown) => error)
    first()
    stop.abort()

    expect(isSendNotAdmitted(await waiting)).toBe(true)
    const next = await Promise.race([queue.acquire(), new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 100))])
    expect(next).not.toBe('held')
  })

  test('under Node: the same boundary', () => {
    const agentModule = new URL('../dist/send-admission.js', import.meta.url).pathname
    const node = spawnSync(spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout.trim(), ['--input-type=module', '-e', `
      const { acquireSendSlot, createSendQueue, isSendNotAdmitted } = await import(${JSON.stringify(agentModule)})
      const queue = createSendQueue(1)
      const first = await queue.acquire()
      const stop = new AbortController()
      const waiting = acquireSendSlot(queue, stop.signal).then(() => 'slot', (error) => error)
      first()
      stop.abort()
      const refused = isSendNotAdmitted(await waiting)
      const freed = await Promise.race([queue.acquire().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))])
      console.log(JSON.stringify({ refused, freed }))
    `], { encoding: 'utf8' })

    expect(node.stderr).toBe('')
    expect(JSON.parse(node.stdout.trim())).toEqual({ refused: true, freed: true })
  })

  test('a submit whose signal aborted is refused at request creation, whatever its admit says', async () => {
    const db = executor()
    const stop = new AbortController()

    // An SDK admission that always admits: the aborted signal still wins.
    const sending = db.submit('INSERT INTO t SELECT 1', 'aborted-at-creation-1', undefined, { admit: () => true, signal: stop.signal })
    stop.abort()
    const error = await sending.catch((e: unknown) => e)

    expect(isSendNotAdmitted(error)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).not.toContain('aborted-at-creation-1')
    await db.close()
  })
})

