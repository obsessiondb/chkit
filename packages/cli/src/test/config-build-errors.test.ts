import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { collectAggregateErrorMessages } from '../runtime/config.js'
import { runCli } from './testkit.test'

describe('collectAggregateErrorMessages (#21)', () => {
  test('extracts every sub-error message from an AggregateError', () => {
    const agg = new AggregateError(
      [new Error("Expected identifier but found \",\""), new Error('Expected "}" but found end of file')],
      '2 errors building config.ts',
    )
    expect(collectAggregateErrorMessages(agg)).toEqual([
      'Expected identifier but found ","',
      'Expected "}" but found end of file',
    ])
  })

  test('handles plain { message } entries (Bun BuildMessage shape) and raw strings', () => {
    expect(collectAggregateErrorMessages({ errors: [{ message: 'boom' }, 'raw'] })).toEqual([
      'boom',
      'raw',
    ])
  })

  test('returns [] when there is no .errors array', () => {
    expect(collectAggregateErrorMessages(new Error('plain'))).toEqual([])
    expect(collectAggregateErrorMessages(null)).toEqual([])
  })
})

describe('@chkit/cli config syntax error surfaces the diagnostics (#21)', () => {
  test('a config with a syntax error prints the underlying errors, not just the summary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-badcfg-'))
    const configPath = join(dir, 'clickhouse.config.ts')
    // Deliberate syntax error (stray commas / unterminated object).
    await writeFile(
      configPath,
      `export default {\n  schema: './schema.ts',\n  clickhouse: { url: 'http://x', database: 'd' ,,,\n}\n`,
      'utf8',
    )
    try {
      const result = runCli(['status', '--config', configPath], { HOME: dir, XDG_CONFIG_HOME: dir })
      expect(result.exitCode).not.toBe(0)
      const combined = `${result.stdout}\n${result.stderr}`
      expect(combined).toContain('Failed to build config')
      // The actual diagnostic — not just "N errors building config.ts".
      expect(combined).toContain('Expected')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
