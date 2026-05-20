import process from 'node:process'
import { createInterface } from 'node:readline/promises'

import type { DestructiveOperationMarker } from '../../runtime/safety-markers.js'

export function isBackgroundOrCI(): boolean {
  return (
    process.env.CI === '1' ||
    process.env.CI === 'true' ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  )
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

async function promptYes(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log('')
    console.log('Type "yes" to continue. Any other input cancels.')
    const response = await rl.question(message)
    return response.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

export function confirmApply(): Promise<boolean> {
  return promptYes('Apply pending migrations now? [no/yes]: ')
}

export async function confirmDestructiveExecution(
  markers: DestructiveOperationMarker[],
): Promise<boolean> {
  printDestructiveOperationDetails(markers)
  return promptYes('Apply destructive operations? [no/yes]: ')
}
