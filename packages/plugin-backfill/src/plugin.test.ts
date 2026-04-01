import { describe, expect, test } from 'bun:test'

import * as sdk from './sdk.js'
import * as root from './index.js'
import { backfill, createBackfillPlugin } from './plugin.js'

describe('@chkit/plugin-backfill plugin surface', () => {
  test('exposes commands and typed registration helper', () => {
    const plugin = createBackfillPlugin()
    const registration = backfill({ maxParallelChunks: 4 })

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
    expect(registration.options?.maxParallelChunks).toBe(4)
  })

  test('keeps internals off the package root and exposes them via sdk', () => {
    expect(root).not.toHaveProperty('analyzeAndChunk')
    expect(root).not.toHaveProperty('executeBackfill')

    expect(sdk).toHaveProperty('analyzeAndChunk')
    expect(sdk).toHaveProperty('executeBackfill')
    expect(sdk).toHaveProperty('buildChunkSql')
  })
})
