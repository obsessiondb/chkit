import { expect, test } from 'bun:test'
import { executeBackfill, type BackfillProgress } from './async-backfill.js'

test.each([
  'submit',
  'poll',
  'progress',
] as const)('abandons a held %s observer after sibling failure without late publication', async (held) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const foreignFinished = Promise.withResolvers<void>()
  const failure = new Error('sibling failed')
  const submissions: string[] = []
  const publications: BackfillProgress[] = []
  let closed = 0
  const run = executeBackfill({
    executor: {
      async command() {},
      async query() {
        return []
      },
      async insert() {},
      async listSchemaObjects() {
        return []
      },
      async listTableDetails() {
        return []
      },
      async close() {
        closed++
      },
      async submit(_sql, queryId = '') {
        submissions.push(queryId)
        if (queryId.endsWith('-a')) {
          await entered.promise
          throw failure
        }
        if (held === 'submit') {
          entered.resolve()
          await release.promise
          foreignFinished.resolve()
        }
        return queryId
      },
      async queryStatus() {
        if (held === 'poll') {
          entered.resolve()
          await release.promise
          foreignFinished.resolve()
        }
        return { status: 'finished' }
      },
    },
    planId: 'abandon',
    chunks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    buildQuery: () => 'SELECT 1',
    concurrency: 2,
    pollIntervalMs: 1,
    async onProgress(progress) {
      publications.push(progress)
      if (held === 'progress') {
        entered.resolve()
        await release.promise
        foreignFinished.resolve()
      }
    },
  }).then(
    () => undefined,
    (error: unknown) => error,
  )
  await entered.promise
  const expired = Promise.withResolvers<Error>()
  const timeout = setTimeout(() => expired.resolve(new Error('Observer did not abandon within one second')), 1000)
  const observed = await Promise.race([run, expired.promise])
  clearTimeout(timeout)
  const publicationCount = publications.length
  release.resolve()
  await foreignFinished.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(observed).toBe(failure)
  expect(await run).toBe(failure)
  expect(submissions).toEqual(['backfill-abandon-a', 'backfill-abandon-b'])
  expect(publications).toHaveLength(publicationCount)
  expect(publications).toHaveLength(held === 'submit' ? 0 : 1)
  expect(closed).toBe(0)
})

test('a publication queued behind an abandoned observer never starts', async () => {
  const publishing = Promise.withResolvers<void>()
  const queued = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const failure = new Error('stop observers')
  let publications = 0
  const run = executeBackfill({
    executor: {
      async command() {},
      async query() {
        return []
      },
      async insert() {},
      async listSchemaObjects() {
        return []
      },
      async listTableDetails() {
        return []
      },
      async close() {},
      async submit(_sql, queryId = '') {
        if (queryId.endsWith('-a')) {
          await queued.promise
          throw failure
        }
        if (queryId.endsWith('-c')) {
          await publishing.promise
          queued.resolve()
        }
        return queryId
      },
      async queryStatus() {
        return { status: 'finished' }
      },
    },
    planId: 'queued',
    chunks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    buildQuery: () => 'SELECT 1',
    concurrency: 3,
    pollIntervalMs: 1,
    async onProgress() {
      publications++
      publishing.resolve()
      await release.promise
      finished.resolve()
    },
  }).then(
    () => undefined,
    (error: unknown) => error,
  )
  await queued.promise
  const expired = Promise.withResolvers<Error>()
  const timeout = setTimeout(() => expired.resolve(new Error('Queued observer did not abandon')), 1000)
  const observed = await Promise.race([run, expired.promise])
  clearTimeout(timeout)
  release.resolve()
  await finished.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(observed).toBe(failure)
  expect(await run).toBe(failure)
  expect(publications).toBe(1)
})
