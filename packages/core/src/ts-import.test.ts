import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { importModuleFile } from './ts-import.js'

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chkit-ts-import-'))
  // A type annotation ensures we exercise TypeScript-specific syntax, not just ESM.
  writeFileSync(join(dir, 'sample.ts'), `export const value: number = 42\nexport default { name: 'sample' }\n`)
  writeFileSync(join(dir, 'sample.mjs'), `export const value = 7\nexport default { name: 'mjs' }\n`)
  return dir
}

describe('importModuleFile', () => {
  test('loads a .ts module with named and default exports under the current runtime', async () => {
    const dir = makeFixtureDir()
    const mod = await importModuleFile(join(dir, 'sample.ts'))
    expect(mod.value).toBe(42)
    expect((mod.default as { name: string }).name).toBe('sample')
    rmSync(dir, { recursive: true, force: true })
  })

  test('loads a plain .mjs module', async () => {
    const dir = makeFixtureDir()
    const mod = await importModuleFile(join(dir, 'sample.mjs'))
    expect(mod.value).toBe(7)
    rmSync(dir, { recursive: true, force: true })
  })

  // Regression guard for finding #1: plain Node cannot natively import a .ts file
  // (ERR_UNKNOWN_FILE_EXTENSION). importModuleFile must load it via jiti under Node.
  test('loads a .ts module under plain Node', () => {
    const dir = makeFixtureDir()
    const tsImportSource = join(import.meta.dir, 'ts-import.ts')
    const script = [
      `const { createJiti } = await import('jiti')`,
      `const jiti = createJiti(import.meta.url)`,
      `const mod = await jiti.import(${JSON.stringify(tsImportSource)})`,
      `const out = await mod.importModuleFile(${JSON.stringify(join(dir, 'sample.ts'))})`,
      `process.stdout.write(JSON.stringify({ value: out.value, name: out.default.name }))`,
    ].join('\n')
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      cwd: import.meta.dir,
      encoding: 'utf8',
    })
    rmSync(dir, { recursive: true, force: true })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ value: 42, name: 'sample' })
  })
})
