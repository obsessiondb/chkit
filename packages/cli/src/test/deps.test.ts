import { describe, expect, test } from 'bun:test'

import { detectPackageManager, installCommand, projectHasCoreDependency } from '../runtime/deps'

describe('installCommand', () => {
  const packages = ['chkit', '@chkit/core', '@chkit/plugin-obsessiondb']

  test('builds a bun dev-install command', () => {
    expect(installCommand('bun')).toEqual({ cmd: 'bun', args: ['add', '-d', ...packages] })
  })

  test('builds an npm dev-install command', () => {
    expect(installCommand('npm')).toEqual({ cmd: 'npm', args: ['install', '-D', ...packages] })
  })

  test('builds a pnpm dev-install command', () => {
    expect(installCommand('pnpm')).toEqual({ cmd: 'pnpm', args: ['add', '-D', ...packages] })
  })

  test('builds a yarn dev-install command', () => {
    expect(installCommand('yarn')).toEqual({ cmd: 'yarn', args: ['add', '-D', ...packages] })
  })
})

describe('detectPackageManager', () => {
  test('reads the package manager from npm_config_user_agent', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'pnpm/9.0.0 npm/? node/v22' })).toBe('pnpm')
  })

  test('defaults to bun when the user agent is absent', () => {
    expect(detectPackageManager({})).toBe('bun')
  })

  test('defaults to bun for an unsupported package manager', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'deno/2.0.0' })).toBe('bun')
  })
})

describe('projectHasCoreDependency', () => {
  test('returns false for a directory with no installed dependencies', () => {
    expect(projectHasCoreDependency('/nonexistent-empty-chkit-dir')).toBe(false)
  })
})
