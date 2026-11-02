import { expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { createRequestQueue } from './request-queue.js'

test('a waiting request honours a pause extended while it waits', async () => {
  const queue = createRequestQueue(2)
  const signal = new AbortController().signal
  const started = performance.now()
  queue.pauseFor(30)
  const waiting = queue.run(async () => performance.now() - started, signal)
  await sleep(10)
  queue.pauseFor(120)
  expect(await waiting).toBeGreaterThanOrEqual(120)
})
