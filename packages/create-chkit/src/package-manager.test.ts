import { describe, expect, test } from 'bun:test'

import { detectPackageManager, isSupportedPackageManager } from './package-manager.js'

describe('detectPackageManager', () => {
  test('returns bun for bun user agent', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'bun/1.3.5 npm/? node/v20.10.0 darwin arm64' })).toBe('bun')
  })

  test('returns npm for npm user agent', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'npm/10.2.4 node/v20.10.0 darwin arm64 workspaces/false' })).toBe('npm')
  })

  test('returns pnpm for pnpm user agent', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'pnpm/9.0.6 npm/? node/v20.10.0 darwin arm64' })).toBe('pnpm')
  })

  test('returns yarn for yarn user agent', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'yarn/1.22.22 npm/? node/v20.10.0 darwin arm64' })).toBe('yarn')
  })

  test('returns undefined when user agent is missing', () => {
    expect(detectPackageManager({})).toBeUndefined()
  })

  test('returns undefined for unknown package managers', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'rush/5.0.0 node/v20.10.0' })).toBeUndefined()
  })
})

describe('isSupportedPackageManager', () => {
  test('accepts supported managers', () => {
    expect(isSupportedPackageManager('npm')).toBe(true)
    expect(isSupportedPackageManager('pnpm')).toBe(true)
    expect(isSupportedPackageManager('yarn')).toBe(true)
    expect(isSupportedPackageManager('bun')).toBe(true)
  })

  test('rejects unknown managers', () => {
    expect(isSupportedPackageManager('rush')).toBe(false)
    expect(isSupportedPackageManager('')).toBe(false)
  })
})
