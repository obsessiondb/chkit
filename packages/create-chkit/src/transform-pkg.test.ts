import { describe, expect, test } from 'bun:test'

import { transformPackageJson } from './transform-pkg.js'

describe('transformPackageJson', () => {
  test('replaces name with project name', () => {
    const result = transformPackageJson({ name: 'chkit-example-clickbench' }, { projectName: 'my-app' })
    expect(result.name).toBe('my-app')
  })

  test('rewrites chkit + @chkit/* deps to latest by default', () => {
    const result = transformPackageJson(
      {
        name: 'chkit-example-clickbench',
        devDependencies: {
          chkit: '0.1.0-beta.24',
          '@chkit/core': '0.1.0-beta.24',
          '@chkit/plugin-obsessiondb': '0.1.0-beta.24',
          typescript: '^5',
        },
      },
      { projectName: 'my-app' },
    )
    expect(result.devDependencies).toEqual({
      chkit: 'latest',
      '@chkit/core': 'latest',
      '@chkit/plugin-obsessiondb': 'latest',
      typescript: '^5',
    })
  })

  test('honors explicit chkitDepVersion', () => {
    const result = transformPackageJson(
      {
        name: 'chkit-example-clickbench',
        dependencies: { chkit: '0.1.0-beta.24' },
      },
      { projectName: 'my-app', chkitDepVersion: '^0.1.0-beta.24' },
    )
    expect(result.dependencies).toEqual({ chkit: '^0.1.0-beta.24' })
  })

  test('rewrites across all dep groups', () => {
    const result = transformPackageJson(
      {
        name: 'pkg',
        dependencies: { chkit: '1' },
        devDependencies: { '@chkit/core': '1' },
        peerDependencies: { '@chkit/plugin-pull': '1' },
        optionalDependencies: { '@chkit/plugin-obsessiondb': '1' },
      },
      { projectName: 'my-app' },
    )
    expect(result.dependencies).toEqual({ chkit: 'latest' })
    expect(result.devDependencies).toEqual({ '@chkit/core': 'latest' })
    expect(result.peerDependencies).toEqual({ '@chkit/plugin-pull': 'latest' })
    expect(result.optionalDependencies).toEqual({ '@chkit/plugin-obsessiondb': 'latest' })
  })

  test('preserves unrelated fields', () => {
    const result = transformPackageJson(
      {
        name: 'old',
        type: 'module',
        scripts: { migrate: 'chkit migrate --apply' },
        private: true,
      } as never,
      { projectName: 'new-app' },
    )
    expect(result.name).toBe('new-app')
    expect((result as { type: string }).type).toBe('module')
    expect((result as { scripts: Record<string, string> }).scripts).toEqual({ migrate: 'chkit migrate --apply' })
    expect(result.private).toBe(true)
  })
})
