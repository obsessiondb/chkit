import { describe, expect, test } from 'bun:test'

import { connectRunbookLines, ensureObsessiondbPluginInSource, runOnboarding } from './index'

const INIT_CONFIG = `import { defineConfig } from '@chkit/core'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  plugins: [
    // Register plugins inline.
  ],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  },
})
`

describe('ensureObsessiondbPluginInSource', () => {
  test('adds the import and registers obsessiondb() in the plugins array', () => {
    const { source, changed } = ensureObsessiondbPluginInSource(INIT_CONFIG)

    expect(changed).toBe(true)
    expect(source).toContain("import { obsessiondb } from '@chkit/plugin-obsessiondb'")
    expect(source).toMatch(/plugins:\s*\[\s*\n\s*obsessiondb\(\),/)
  })

  test('is a no-op when obsessiondb() is already registered', () => {
    const already = `import { obsessiondb } from '@chkit/plugin-obsessiondb'

export default defineConfig({ plugins: [obsessiondb()] })
`
    const { source, changed } = ensureObsessiondbPluginInSource(already)

    expect(changed).toBe(false)
    expect(source).toBe(already)
  })

  test('does not change a config without a plugins array', () => {
    const noPlugins = `export default defineConfig({ schema: './x' })\n`
    const { source, changed } = ensureObsessiondbPluginInSource(noPlugins)

    expect(changed).toBe(false)
    expect(source).toBe(noPlugins)
  })
})

describe('runOnboarding', () => {
  // bun:test runs without a TTY, so an explicit `--connect claim` with no email can't finish
  // signup. It must throw (non-zero exit) rather than fall through to next-steps with status 0.
  test('throws on an explicit claim that cannot finish signup non-interactively', async () => {
    await expect(
      runOnboarding({ configPath: '/chkit-nonexistent/clickhouse.config.ts', connect: 'claim' }),
    ).rejects.toThrow(/Signup did not complete/)
  })
})

describe('connectRunbookLines', () => {
  test('lists all three connect paths as runnable commands', () => {
    const text = connectRunbookLines().join('\n')
    expect(text).toContain('chkit obsessiondb signup --email <you@example.com>')
    expect(text).toContain('chkit obsessiondb signup --email <you@example.com> --code <CODE>')
    expect(text).toContain('chkit obsessiondb service claim')
    expect(text).toContain('chkit obsessiondb login')
    expect(text).toContain('CLICKHOUSE_URL')
  })
})
