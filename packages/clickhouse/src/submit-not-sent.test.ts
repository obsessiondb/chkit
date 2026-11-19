import { describe, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'

import { createStatelessClickHouseExecutor, failedBeforeSending, isSubmitNotSentError } from './index.js'

// #800: a submit proves it was never sent only when its connect was refused or
// its host did not resolve. Every other failure may follow a request the
// server read, and keeps the error a poll has to explain.

function listen(onConnection: (socket: Socket, received: Buffer[]) => void): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = []
  const server = createServer((socket) => onConnection(socket, received))
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no TCP address')
      resolve({ server, port: address.port, received })
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function closedPort(): Promise<number> {
  const { server, port } = await listen((socket) => socket.destroy())
  await close(server)
  return port
}

function submitTo(url: string): Promise<unknown> {
  const executor = createStatelessClickHouseExecutor({ url, username: 'default', password: '', database: 'default' })
  return executor.submit('INSERT INTO t SELECT 1', 'r800-id').then(
    () => {
      throw new Error('the submit succeeded')
    },
    (error: unknown) => error,
  )
}

describe('submit that never sent its request (#800)', () => {
  test('a refused connect is never sent', async () => {
    const port = await closedPort()
    const error = await submitTo(`http://127.0.0.1:${port}`)
    expect(isSubmitNotSentError(error)).toBe(true)
    expect((error as Error).message).toBe(`Could not connect to ClickHouse at http://127.0.0.1:${port} (connection refused)`)
  })

  test('a host that does not resolve is never sent', async () => {
    const error = await submitTo('http://chkit-r800.invalid:8123')
    expect(isSubmitNotSentError(error)).toBe(true)
    expect((error as Error).message).toBe('Could not connect to ClickHouse at http://chkit-r800.invalid:8123 (host not found)')
  })

  test('a connection reset after the server read the request may have been sent', async () => {
    const { server, port, received } = await listen((socket, chunks) => {
      socket.once('data', (chunk) => {
        chunks.push(chunk)
        socket.resetAndDestroy()
      })
    })
    const error = await submitTo(`http://127.0.0.1:${port}`)
    await close(server)
    expect(Buffer.concat(received).toString()).toContain('POST')
    expect(error).toBeInstanceOf(Error)
    expect(isSubmitNotSentError(error)).toBe(false)
  })

  test('a connection the server closed after it accepted may have been sent', async () => {
    const { server, port } = await listen((socket) => socket.destroy())
    const error = await submitTo(`http://127.0.0.1:${port}`)
    await close(server)
    expect(error).toBeInstanceOf(Error)
    expect(isSubmitNotSentError(error)).toBe(false)
  })

  for (const [label, status] of [['a 401', 401], ['a gateway 502', 502], ['a gateway 524', 524]] as const) {
    test(`${label} response was sent`, async () => {
      const { server, port } = await listen((socket) => {
        socket.once('data', () => socket.end(`HTTP/1.1 ${status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`))
      })
      const error = await submitTo(`http://127.0.0.1:${port}`)
      await close(server)
      expect(error).toBeInstanceOf(Error)
      expect(isSubmitNotSentError(error)).toBe(false)
    })
  }

  const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED', syscall: 'connect' })
  const errno = (message: string, code: string, syscall: string) => Object.assign(new Error(message), { code, syscall })
  test.each([
    ['a refused connect', refused(), true],
    ['a failed host lookup', errno('getaddrinfo ENOTFOUND h', 'ENOTFOUND', 'getaddrinfo'), true],
    ['a temporary lookup failure', errno('getaddrinfo EAI_AGAIN h', 'EAI_AGAIN', 'getaddrinfo'), true],
    ['every address of the host refused', Object.assign(new AggregateError([refused(), refused()]), { code: 'ECONNREFUSED' }), true],
    ['an ECONNREFUSED outside the connect', errno('read ECONNREFUSED', 'ECONNREFUSED', 'read'), false],
    ['a reset', errno('read ECONNRESET', 'ECONNRESET', 'read'), false],
    ['a broken pipe', errno('write EPIPE', 'EPIPE', 'write'), false],
    ['a connect timeout', errno('connect ETIMEDOUT 10.0.0.1:8123', 'ETIMEDOUT', 'connect'), false],
    ['an unreachable host', errno('connect EHOSTUNREACH 10.0.0.1:8123', 'EHOSTUNREACH', 'connect'), false],
    ['one address refused, another timed out', new AggregateError([refused(), errno('connect ETIMEDOUT', 'ETIMEDOUT', 'connect')]), false],
    ['no address tried', new AggregateError([]), false],
    ['a message that only names ECONNREFUSED', new Error('connect ECONNREFUSED 127.0.0.1:1'), false],
    ['a wrapped message', new Error('Could not connect to ClickHouse at http://127.0.0.1:1 (connection refused)'), false],
  ])('%s', (_label, error, expected) => {
    expect(failedBeforeSending(error)).toBe(expected)
  })
})
