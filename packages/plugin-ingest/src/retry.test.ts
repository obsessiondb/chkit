import { describe, expect, test } from 'bun:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { HttpError } from './errors.js'
import { runAttempt } from './retry.js'
import { createSourceContext } from './testing.js'
import type { RetryContext } from './types.js'

const signal = new AbortController().signal
const env = { signal, onRetry: () => undefined }
const immediate = { minTimeout: 0, randomize: false }
const httpError = (status: number, retryAfter = '0') =>
  HttpError.fromResponse(new Response('', { status, headers: { 'retry-after': retryAfter } }))

describe('provider retry policy', () => {
  test('reports the provider Retry-After to the caller', async () => {
    const limited = await httpError(429, '0.03')
    const transient = await httpError(503)
    const retries: Array<{ context: RetryContext; retryAfterMs: number | undefined }> = []
    const value = await runAttempt(async (attempt) => {
      if (attempt === 1) throw limited
      if (attempt === 2) throw transient
      return 'ok'
    }, { ...immediate, retries: 1 }, { ...env, onRetry: (context, retryAfterMs) => { retries.push({ context, retryAfterMs }) } })

    expect(value).toBe('ok')
    expect(retries.map(({ context, retryAfterMs }) => ({ attemptNumber: context.attemptNumber, retriesConsumed: context.retriesConsumed, retryAfterMs }))).toEqual([
      { attemptNumber: 1, retriesConsumed: 0, retryAfterMs: 30 },
      { attemptNumber: 2, retriesConsumed: 0, retryAfterMs: undefined },
    ])
    expect(retries[0]?.context.error.cause).toBe(limited)
  })

  test('a request waits out the provider Retry-After before it is sent again', async () => {
    const sent: number[] = []
    const context = createSourceContext({
      retry: { ...immediate, retries: 1 },
      fetch: async () => {
        sent.push(performance.now())
        return sent.length === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0.03' } }) : Response.json({ ok: true })
      },
    })
    expect(await (await context.fetch('https://api.example.com/items')).json()).toEqual({ ok: true })
    expect((sent[1] ?? 0) - (sent[0] ?? 0)).toBeGreaterThanOrEqual(25)
  })

  test('does not schedule a retry when Retry-After exceeds maxRetryTime', async () => {
    let calls = 0
    let scheduled = 0
    const failure = await httpError(429, '60')
    await expect(runAttempt(async () => {
      calls += 1
      throw failure
    }, { ...immediate, maxRetryTime: 100 }, {
      ...env, onRetry: () => { scheduled += 1 },
    })).rejects.toBe(failure)
    expect(calls).toBe(1)
    expect(scheduled).toBe(0)
  })

  test.each(['backoff', 'retry-after'] as const)('cancellation interrupts %s without calling the provider again', async (mode) => {
    const controller = new AbortController()
    let calls = 0
    const timer = setTimeout(() => controller.abort(new Error('cancelled')), 20)
    const context = createSourceContext({
      signal: controller.signal,
      retry: { retries: 1, minTimeout: mode === 'backoff' ? 60_000 : 0 },
      fetch: async () => {
        calls += 1
        return new Response('unavailable', { status: mode === 'backoff' ? 503 : 429, headers: { 'retry-after': '60' } })
      },
    })
    try {
      await expect(context.fetch('https://api.example.com/items')).rejects.toThrow()
      expect(calls).toBe(1)
    } finally {
      clearTimeout(timer)
    }
  })

  test('rejects with exactly the thrown value, also once retries are exhausted', async () => {
    const plain = { providerCode: 'NO_ACCESS' }
    await expect(runAttempt(async () => { throw plain }, immediate, env)).rejects.toBe(plain)
    const reset = connectionReset()
    let calls = 0
    await expect(runAttempt(async () => { calls += 1; throw reset }, { ...immediate, retries: 1 }, env)).rejects.toBe(reset)
    expect(calls).toBe(2)
  })

  test('a failure after execution cancellation is not retried, even when it looks transient', async () => {
    const controller = new AbortController()
    let calls = 0
    await expect(runAttempt(async () => {
      calls += 1
      controller.abort(new Error('host cancelled'))
      throw new DOMException('request aborted', 'AbortError')
    }, immediate, { ...env, signal: controller.signal })).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test('retries only transient failures; anything else rejects at once', async () => {
    const calls = async (failure: () => unknown) => {
      let count = 0
      await expect(runAttempt(async () => {
        count += 1
        throw await failure()
      }, { ...immediate, retries: 2 }, env)).rejects.toBeDefined()
      return count
    }
    expect(await calls(connectionReset)).toBe(3)
    expect(await calls(() => new TypeError('fetch failed', { cause: connectionReset() }))).toBe(3)
    expect(await calls(() => httpError(503))).toBe(3)
    expect(await calls(() => new Error('Provider request failed', { cause: connectionReset() }))).toBe(3)
    for (const deterministic of [
      () => httpError(401),
      () => new TypeError("Cannot read properties of undefined (reading 'items')"),
      () => new SyntaxError('Unexpected token < in JSON'),
      () => new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
    ]) {
      expect(await calls(deterministic)).toBe(1)
    }
  })

  test('a rate limit the provider schedules does not use up the retry count', async () => {
    let limited = 0
    expect(await runAttempt(async () => {
      limited += 1
      if (limited <= 3) throw await httpError(429, '0.01')
      return 'ok'
    }, { ...immediate, retries: 1 }, env)).toBe('ok')
    expect(limited).toBe(4)

    let unavailable = 0
    await expect(runAttempt(async () => {
      unavailable += 1
      throw await httpError(503)
    }, { ...immediate, retries: 1 }, env)).rejects.toBeDefined()
    expect(unavailable).toBe(2)
  })

  test('a reader recovers from its own error type, because attempts reject with it unchanged', async () => {
    class CursorExpired extends Error {}
    const expired = new CursorExpired('cursor expired')
    let calls = 0
    await expect(runAttempt(async () => { calls += 1; throw expired }, immediate, env)).rejects.toBe(expired)
    expect(calls).toBe(1)
  })

  test('an HTTP error built from a constructed response names only what it has', async () => {
    expect((await HttpError.fromResponse(new Response('{"error":"ratelimited"}', { status: 429 }))).message).toBe('HTTP 429: {"error":"ratelimited"}')
    expect((await HttpError.fromResponse(new Response('', { status: 503, statusText: 'Service Unavailable' }))).message).toBe('HTTP 503 Service Unavailable')
  })

  test('withStatus turns a failure reported inside a successful response into the status it means', async () => {
    const limited = HttpError.withStatus(new Response('{"ok":false}', { headers: { 'retry-after': '2' } }), 429, { body: '{"error":"ratelimited"}' })
    expect(limited).toMatchObject({ status: 429, retryAfterMs: 2000, message: 'HTTP 429: {"error":"ratelimited"}' })
    expect(HttpError.withStatus(new Response('{}'), 429, { retryAfterMs: 60_000 }).retryAfterMs).toBe(60_000)
    const fromServer = await withServer((_, response) => { response.end('{"ok":false}') }, async (url) => HttpError.withStatus(await fetch(url), 503))
    expect(fromServer.message).toMatch(/^HTTP 503 for http:\/\/127\.0\.0\.1:\d+\/$/)
  })

  test('real fetch failures retry when the network fails, not when the request is wrong', async () => {
    const retried = async (url: string, init?: RequestInit) => {
      let calls = 0
      await expect(runAttempt(async () => {
        calls += 1
        await fetch(url, init)
      }, { ...immediate, retries: 1 }, env)).rejects.toBeDefined()
      return calls
    }
    const closed = await withServer(() => undefined, async (url) => url)
    expect(await retried(closed)).toBe(2)
    expect(await withServer((request) => { request.socket.destroy() }, (url) => retried(url))).toBe(2)
    expect(await withServer(() => undefined, (url) => retried(url, { signal: AbortSignal.timeout(50) }))).toBe(2)
    expect(await withServer((_, response) => { response.writeHead(302, { location: '/elsewhere' }).end() }, (url) => retried(url, { redirect: 'error' }))).toBe(1)
  })
})

function connectionReset(): Error {
  return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
}

async function withServer<T>(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (url: string) => Promise<T>): Promise<T> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/`
  try {
    return await run(url)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
