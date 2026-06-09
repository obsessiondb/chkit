import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { importModuleFile } from './ts-import.js'

const TS_FIXTURE = `export const value: number = 42\nexport default { name: 'sample' }\n`

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chkit-ts-import-'))
  // A type annotation ensures we exercise TypeScript-specific syntax, not just ESM.
  writeFileSync(join(dir, 'sample.ts'), TS_FIXTURE)
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
  //
  // We transpile ts-import.ts to plain JS and run THAT under Node, rather than
  // loading the .ts source through jiti — otherwise jiti's transform would also
  // intercept importModuleFile's own dynamic import() and mask a native-import
  // regression. The temp dir lives under the repo root so the compiled module's
  // `import('jiti')` resolves against the workspace node_modules.
  test('loads a .ts module under plain Node (compiled, no jiti wrapper)', () => {
    const repoRoot = resolve(import.meta.dir, '../../..')
    const dir = mkdtempSync(join(repoRoot, '.tmp-node-loader-'))
    const sourceTs = readFileSync(join(import.meta.dir, 'ts-import.ts'), 'utf8')
    const compiledJs = new Bun.Transpiler({ loader: 'ts' }).transformSync(sourceTs)
    writeFileSync(join(dir, 'ts-import.mjs'), compiledJs)
    writeFileSync(join(dir, 'sample.ts'), TS_FIXTURE)

    const script = [
      `const mod = await import('./ts-import.mjs')`,
      `const out = await mod.importModuleFile('./sample.ts')`,
      `process.stdout.write(JSON.stringify({ value: out.value, name: out.default.name }))`,
    ].join('\n')
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      cwd: dir,
      encoding: 'utf8',
    })
    rmSync(dir, { recursive: true, force: true })

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('ERR_UNKNOWN_FILE_EXTENSION')
    expect(JSON.parse(result.stdout)).toEqual({ value: 42, name: 'sample' })
  })
})
