import { describe, expect, test } from 'bun:test'

import { backfill, createBackfillPlugin } from './plugin.js'

describe('@chkit/plugin-backfill plugin surface', () => {
  test('exposes commands and typed registration helper', () => {
    const plugin = createBackfillPlugin()
    const registration = backfill({ defaults: { chunkHours: 4 } })

    expect(plugin.manifest.name).toBe('backfill')
    expect(plugin.manifest.apiVersion).toBe(1)
    expect(plugin.commands.map((command) => command.name)).toEqual([
      'plan',
      'run',
      'resume',
      'status',
      'cancel',
      'doctor',
    ])
    expect(registration.name).toBe('backfill')
    expect(registration.enabled).toBe(true)
    expect(registration.options?.defaults?.chunkHours).toBe(4)
  })
})
