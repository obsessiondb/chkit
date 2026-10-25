import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'

const root = pathToFileURL(`${process.argv[2]}/`)
const { cursorState, definePipeline, defineStream, IngestConfigError, rawTable, runIngestion, selectStreams } = await import(new URL('index.js', root))
const { createMemoryDestination, createMemoryJournal } = await import(new URL('testing.js', root))
const { foreign, runPublic } = await import(new URL('runtime.js', root))
const watchdog = setTimeout(() => { console.error('Commit ownership did not settle within 20 seconds'); process.exit(1) }, 20_000)

try {
  await immediateSourceFailure()
  await healthyPendingCommit()
  await interruptedCommit(false)
  await interruptedCommit(true)
  await hostCancellation()
  await ownerAbandonment()
  console.log(JSON.stringify({ scenarios: 6, ok: true }))
} finally {
  clearTimeout(watchdog)
}

async function immediateSourceFailure() {
  const fixture = createFixture({ sourceFailure: 'immediate' })
  const result = await runIngestion(fixture.request, fixture.env)
  assert.equal(result.streams[0].error, fixture.sourceError.message)
  assert.equal(result.streams[0].checkpointVersion, 1)
  assert.equal(result.streams[0].batches, 1)
  assert.equal((await fixture.journal.readCheckpoint('commits')).envelope.state, 1)
  assert.equal(fixture.journal.events.find((event) => event.eventKind === 'work_finished').errorClass, 'config')
  assert.equal(fixture.completed(), 0)
}

async function healthyPendingCommit() {
  const fixture = createFixture({ hold: true })
  const observer = observeGrace()
  const running = hosted(runIngestion, fixture, observer.clock)
  await fixture.entered.promise
  await fixture.producerDone.promise
  assert.equal(observer.count(), 0)
  assert.equal((await fixture.journal.readCheckpoint('commits')).envelope, undefined)
  fixture.release.resolve()
  const result = await running
  assert.equal(result.ok, true)
  assert.equal(result.streams[0].checkpointVersion, 1)
  assert.equal(observer.count(), 0)
}

async function interruptedCommit(late) {
  const fixture = createFixture({ hold: true, sourceFailure: 'after-append' })
  const observer = observeGrace()
  const running = hosted(runIngestion, fixture, observer.clock)
  await observer.entered.promise
  if (!late) fixture.release.resolve()
  const result = await running
  const stream = result.streams[0]
  assert.equal(stream.outcome, 'failed')
  assert.equal(stream.error, fixture.sourceError.message)
  assert.equal(stream.checkpointVersion, late ? 0 : 1)
  assert.equal(stream.batches, late ? 0 : 1)
  assert.equal(fixture.completed(), 0)
  assert.equal(observer.count(), 1)
  const calls = fixture.calls.length
  const published = JSON.stringify(result)
  fixture.release.resolve()
  await setImmediate()
  assert.equal(fixture.calls.length, calls)
  assert.equal(JSON.stringify(result), published)
  assert.equal((await fixture.journal.readCheckpoint('commits')).envelope.state, 1)
  assert.equal(fixture.journal.events.some((event) => event.eventKind === 'work_finished'), !late)
}

async function hostCancellation() {
  const controller = new AbortController()
  const fixture = createFixture({ hold: true, signal: controller.signal })
  const running = runIngestion(fixture.request, fixture.env)
  await fixture.entered.promise
  controller.abort(new Error('host cancelled'))
  const result = await running
  assert.equal(result.streams[0].outcome, 'cancelled')
  assert.equal(result.streams[0].checkpointVersion, 0)
  assert.equal(result.streams[0].batches, 0)
  const calls = fixture.calls.length
  fixture.release.resolve()
  await setImmediate()
  assert.equal(fixture.calls.length, calls)
  assert.equal(result.streams[0].checkpointVersion, 0)
}

async function ownerAbandonment() {
  const fixture = createFixture({ hold: true })
  const observer = observeGrace()
  const owned = gate()
  const outerError = new Error('outer owner failed')
  const running = runPublic(Effect.scoped(Effect.gen(function* () {
    const child = yield* Effect.forkScoped(foreign(() => runIngestion(fixture.request, fixture.env)))
    owned.resolve(child)
    yield* foreign(() => Promise.all([fixture.entered.promise, fixture.producerDone.promise]))
    return yield* Effect.fail(outerError)
  })).pipe(Effect.provideService(Clock.Clock, observer.clock))).then(
    () => { throw new Error('Owner unexpectedly succeeded') },
    (error) => error,
  )
  const child = await owned.promise
  await observer.entered.promise
  child.interruptUnsafe()
  assert.equal(await running, outerError)
  assert.equal(observer.count(), 1)
  const calls = fixture.calls.length
  assert.equal(fixture.journal.events.some((event) => event.eventKind === 'work_finished'), false)
  fixture.release.resolve()
  await setImmediate()
  assert.equal(fixture.calls.length, calls)
}

function createFixture({ hold = false, sourceFailure, signal } = {}) {
  const memory = createMemoryJournal()
  const entered = gate()
  const release = gate()
  const producerDone = gate()
  const calls = []
  let completed = 0
  const sourceError = new IngestConfigError('next interval denied')
  const journal = {
    ...memory,
    async append(events) {
      calls.push(events.map((event) => event.eventKind))
      if (events.some((event) => event.eventKind === 'batch_committed')) {
        entered.resolve()
        if (hold) await release.promise
      }
      await memory.append(events)
    },
  }
  const stream = defineStream({
    id: 'commits', destination: rawTable({ database: 'test', name: 'commits' }), retry: { retries: 0 },
    incremental: {
      ...cursorState({ id: 'commit-cursor', version: 1, parse: Number }),
      complete() { completed += 1; producerDone.resolve() },
    },
    async *read(context) {
      await context.attempt(async () => [])
      yield { rows: [], state: 1, id: 'completed-first-interval' }
      if (sourceFailure === 'after-append') await entered.promise
      if (sourceFailure) await context.attempt(async () => { throw sourceError })
    },
  })
  return {
    journal, entered, release, producerDone, sourceError, calls, completed: () => completed,
    request: { selected: selectStreams([definePipeline({ id: 'commit-tests', streams: [stream] })], []), backfill: undefined },
    env: { journal, destination: createMemoryDestination(), signal, maxDurationMs: 15_000 },
  }
}

function observeGrace() {
  const live = Effect.runSync(Clock.Clock)
  const entered = gate()
  let sleeps = 0
  const clock = Object.assign(Object.create(live), {
    sleep(duration) {
      if (Duration.toMillis(duration) === 5000) { sleeps += 1; entered.resolve() }
      return live.sleep(duration)
    },
  })
  return { clock, entered, count: () => sleeps }
}

function hosted(operation, fixture, clock) {
  return runPublic(Effect.scoped(foreign(() => operation(fixture.request, fixture.env))).pipe(Effect.provideService(Clock.Clock, clock)))
}

function gate() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
