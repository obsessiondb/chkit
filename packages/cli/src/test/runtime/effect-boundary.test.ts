import { expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import { ensuring, fromPromise, runEffect } from '../../runtime/effect.js'

test('ordinary failures and defects preserve their original identity', async () => {
  const failure = new Error('expected failure')
  const defect = new Error('unexpected defect')
  await expect(runEffect(Effect.fail(failure))).rejects.toBe(failure)
  await expect(runEffect(Effect.die(defect))).rejects.toBe(defect)
  await expect(runEffect(fromPromise(() => { throw failure }))).rejects.toBe(failure)
  await expect(runEffect(fromPromise(() => Promise.reject('plain rejection')))).rejects.toBe('plain rejection')
})

test('interruption is normalized without exposing a runtime cause', async () => {
  await expect(runEffect(Effect.interrupt)).rejects.toThrow('CLI execution is no longer active.')
})

test('cleanup failure takes precedence over an earlier defect', async () => {
  const defect = new Error('body')
  const cleanup = new Error('cleanup')
  await expect(runEffect(ensuring(Effect.die(defect), Effect.fail(cleanup)))).rejects.toBe(cleanup)
})

test('closing an owner aborts a nested foreign request and prevents its continuation', async () => {
  const started = Promise.withResolvers<void>()
  let nested: Promise<void> | undefined
  let aborted = false
  let continued = false
  await runEffect(Effect.gen(function* () {
    yield* fromPromise(() => {
      nested = runEffect(Effect.gen(function* () {
        yield* fromPromise((signal) => new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('request aborted'))
          }, { once: true })
          started.resolve()
        }))
        continued = true
      }))
      void nested.catch(() => {})
      return started.promise
    })
  }))
  expect(nested).toBeDefined()
  await expect(nested).rejects.toThrow('CLI execution is no longer active.')
  expect(aborted).toBe(true)
  expect(continued).toBe(false)
})
