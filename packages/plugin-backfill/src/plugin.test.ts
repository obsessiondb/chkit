import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import * as sdk from './sdk.js'
import * as root from './index.js'
import { backfill, createBackfillPlugin } from './plugin.js'

const pluginBackfillPackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as {
  exports: Record<string, { source: string; types: string; default: string }>
}

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
    expect(sdk).toHaveProperty('configureSync')
    expect(sdk).toHaveProperty('generateChunkPlan')
    expect(sdk).toHaveProperty('getBackfillLogger')
    expect(sdk).toHaveProperty('getConsoleSink')
    expect(sdk).toHaveProperty('executeBackfill')
    expect(sdk).toHaveProperty('buildChunkExecutionSql')
    expect(sdk).toHaveProperty('buildWhereClauseFromChunk')
    expect(sdk).toHaveProperty('encodeChunkPlanForPersistence')
    expect(sdk).toHaveProperty('decodeChunkPlanFromPersistence')
    expect(sdk).toHaveProperty('generateIdempotencyToken')
  })

  test('package exports declare root and sdk subpath separately', () => {
    expect(pluginBackfillPackage.exports['.']).toEqual({
      source: './src/index.ts',
      types: './dist/index.d.ts',
      default: './dist/index.js',
    })
    expect(pluginBackfillPackage.exports['./sdk']).toEqual({
      source: './src/sdk.ts',
      types: './dist/sdk.d.ts',
      default: './dist/sdk.js',
    })
  })
})
