import { describe, expect, test } from 'bun:test'
import { MissingFlagValueError } from '@chkit/core'

import { extractConfigPath } from '../../runtime/extract-config-path.js'

describe('extractConfigPath', () => {
  test('returns undefined when --config is absent', () => {
    expect(extractConfigPath(['generate'])).toBeUndefined()
  })

  test('reads --config followed by a separate value', () => {
    expect(extractConfigPath(['generate', '--config', 'a.ts'])).toBe('a.ts')
  })

  test('reads --config=value equals form', () => {
    expect(extractConfigPath(['generate', '--config=a.ts'])).toBe('a.ts')
  })

  test('reads --config when it appears after the command name', () => {
    expect(extractConfigPath(['migrate', 'apply', '--config', 'a.ts'])).toBe('a.ts')
  })

  test('stops scanning at "--" so trailing values are not picked up', () => {
    expect(extractConfigPath(['query', '--', '--config', 'a.ts'])).toBeUndefined()
  })

  test('last --config wins when multiple are present, as parseFlags and chkit-py keep (#574)', () => {
    expect(extractConfigPath(['--config', 'first.ts', '--config', 'second.ts'])).toBe('second.ts')
    expect(extractConfigPath(['generate', '--config=first.ts', '--config=second.ts'])).toBe('second.ts')
    expect(extractConfigPath(['generate', '--config', 'first.ts', '--config=second.ts'])).toBe('second.ts')
    expect(extractConfigPath(['generate', '--config=first.ts', '--json', '--config', 'second.ts'])).toBe('second.ts')
  })

  test('a --config after "--" does not override an earlier one', () => {
    expect(extractConfigPath(['query', '--config', 'a.ts', '--', '--config', 'b.ts'])).toBe('a.ts')
  })

  test('a --config without a value throws before any config is loaded, as parseFlags would', () => {
    for (const argv of [
      ['status', '--config'],
      ['status', '--config', '--json'],
      ['status', '--config', 'a.ts', '--config'],
      ['status', '--config', 'a.ts', '--config', '--json'],
      ['status', '--config', 'a.ts', '--config', '--', '--config', 'b.ts'],
    ]) {
      expect(() => extractConfigPath(argv)).toThrow(new MissingFlagValueError('--config'))
    }
  })

  test('returns empty string when --config=  (empty value) is given', () => {
    expect(extractConfigPath(['--config='])).toBe('')
  })
})
