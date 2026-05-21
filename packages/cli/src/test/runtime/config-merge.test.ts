import { describe, expect, test } from 'bun:test'

import type { ChxUserConfig } from '@chkit/core'

import { mergeUserConfig, pluginNameOf } from '../../runtime/config-merge.js'

const profile: ChxUserConfig = {
  schema: [],
  outDir: './from-profile',
  plugins: [
    { plugin: { manifest: { name: 'obsessiondb' } }, name: 'obsessiondb', options: { service: 'from-profile' } },
  ],
  clickhouse: {
    url: 'https://profile.example/clickhouse',
    username: 'profile-user',
    database: 'profile_db',
  },
  check: { failOnDrift: false },
  safety: { allowDestructive: true },
}

describe('mergeUserConfig', () => {
  test('overlay scalar fields beat base', () => {
    const merged = mergeUserConfig(profile, {
      schema: ['./schema/*.ts'],
      outDir: './from-project',
    })
    expect(merged.schema).toEqual(['./schema/*.ts'])
    expect(merged.outDir).toBe('./from-project')
  })

  test('falls back to base when overlay field is missing', () => {
    const merged = mergeUserConfig(profile, { schema: ['./schema/*.ts'] })
    expect(merged.outDir).toBe('./from-profile')
  })

  test('plugins from base are kept when overlay has no plugins field', () => {
    const merged = mergeUserConfig(profile, { schema: [] })
    expect(merged.plugins).toHaveLength(1)
    expect((merged.plugins ?? []).map(pluginNameOf)).toEqual(['obsessiondb'])
  })

  test('plugins concatenate when names differ', () => {
    const merged = mergeUserConfig(profile, {
      schema: [],
      plugins: [{ plugin: { manifest: { name: 'codegen' } }, name: 'codegen' }],
    })
    expect(merged.plugins).toHaveLength(2)
    expect((merged.plugins ?? []).map(pluginNameOf)).toEqual(['obsessiondb', 'codegen'])
  })

  test('overlay plugin with same name replaces base plugin', () => {
    const merged = mergeUserConfig(profile, {
      schema: [],
      plugins: [
        { plugin: { manifest: { name: 'obsessiondb' } }, name: 'obsessiondb', options: { service: 'from-project' } },
      ],
    })
    expect(merged.plugins).toHaveLength(1)
    const reg = (merged.plugins ?? [])[0] as { options?: { service?: string } }
    expect(reg.options?.service).toBe('from-project')
  })

  test('explicit empty plugins array in overlay still concatenates (overlay contributes nothing)', () => {
    const merged = mergeUserConfig(profile, { schema: [], plugins: [] })
    expect(merged.plugins).toHaveLength(1)
    expect((merged.plugins ?? []).map(pluginNameOf)).toEqual(['obsessiondb'])
  })

  test('clickhouse is field-by-field merged with overlay winning', () => {
    const merged = mergeUserConfig(profile, {
      schema: [],
      clickhouse: { url: 'https://project.example/clickhouse', password: 'secret' },
    })
    expect(merged.clickhouse).toEqual({
      url: 'https://project.example/clickhouse',
      username: 'profile-user',
      database: 'profile_db',
      password: 'secret',
    })
  })

  test('check and safety fields merge shallowly', () => {
    const merged = mergeUserConfig(profile, {
      schema: [],
      check: { failOnPending: false },
    })
    expect(merged.check).toEqual({ failOnDrift: false, failOnPending: false })
    expect(merged.safety).toEqual({ allowDestructive: true })
  })

  test('handles base without optional fields', () => {
    const merged = mergeUserConfig(
      { schema: [] },
      { schema: ['./a.ts'], outDir: './out' },
    )
    expect(merged.outDir).toBe('./out')
    expect(merged.plugins).toBeUndefined()
    expect(merged.clickhouse).toBeUndefined()
  })
})

describe('pluginNameOf', () => {
  test('reads explicit name from inline registration', () => {
    expect(pluginNameOf({ plugin: {}, name: 'mine' })).toBe('mine')
  })

  test('falls back to manifest.name on inline registration', () => {
    expect(pluginNameOf({ plugin: { manifest: { name: 'codegen' } } })).toBe('codegen')
  })

  test('reads explicit name from legacy registration', () => {
    expect(pluginNameOf({ resolve: './foo.js', name: 'mine' })).toBe('mine')
  })

  test('falls back to basename for legacy registration', () => {
    expect(pluginNameOf({ resolve: '/abs/pkg/dist/index.js' })).toBe('index')
  })

  test('returns basename for string registration', () => {
    expect(pluginNameOf('./plugins/my-plugin.js')).toBe('my-plugin')
  })
})
