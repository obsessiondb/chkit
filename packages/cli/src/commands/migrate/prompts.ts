import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import * as Effect from 'effect/Effect'

import { ensuring, fromPromise, runEffect } from '../../runtime/effect.js'
import type { DestructiveOperationMarker } from '../../runtime/safety-markers.js'

export function isBackgroundOrCI(): boolean {
  return process.env.CI === '1' || process.env.CI === 'true' || !process.stdin.isTTY || !process.stdout.isTTY
}

export function printDestructiveOperationDetails(markers: DestructiveOperationMarker[]): void {
  console.log('Destructive operations detected:')
  for (const [index, marker] of markers.entries()) {
    console.log(`${index + 1}. ${marker.migration}`)
    console.log(`   operation: ${marker.type}`)
    console.log(`   key: ${marker.key}`)
    console.log(`   warning: ${marker.warningCode}`)
    console.log(`   reason: ${marker.reason}`)
    console.log(`   impact: ${marker.impact}`)
    console.log(`   recommendation: ${marker.recommendation}`)
  }
}

function promptYes(message: string): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    return yield* ensuring(
      Effect.gen(function* () {
        console.log('')
        console.log('Type "yes" to continue. Any other input cancels.')
        const response = yield* fromPromise(() => rl.question(message))
        return response.trim().toLowerCase() === 'yes'
      }),
      fromPromise(() => rl.close()),
    )
  })
}

export function confirmApply(): Promise<boolean> {
  return runEffect(promptYes('Apply pending migrations now? [no/yes]: '))
}

export function confirmAbandon(migration: string): Promise<boolean> {
  return runEffect(promptYes(`Abandon the in-progress state of ${migration} now? [no/yes]: `))
}

export function confirmDestructiveExecution(markers: DestructiveOperationMarker[]): Promise<boolean> {
  return runEffect(
    Effect.gen(function* () {
      printDestructiveOperationDetails(markers)
      return yield* promptYes('Apply destructive operations? [no/yes]: ')
    }),
  )
}
