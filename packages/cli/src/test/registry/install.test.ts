import { afterEach, expect, test } from 'bun:test'
import { readFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { applyInstallation, describePlan, planInstallation } from '../../registry/install.js'
import { FIXTURE_VERSION, fixtureTracker, installFixtureDependencies, write } from './fixtures.js'

const fixtures = fixtureTracker()
afterEach(() => fixtures.cleanup())

test.serial('planning an empty install is a dry run and applying needs no provider credentials', async () => {
  const fixture = await fixtures.create()
  const plan = await planInstallation({ cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, noInstall: true, packageManager: 'bun' })
  expect(await readdir(fixture.project)).toEqual([])
  expect(describePlan(plan).files.find((file) => file.path === 'clickhouse.config.ts')?.action).toBe('create')
  expect(plan.dependencies).toEqual([...fixture.item.dependencies, `chkit@${FIXTURE_VERSION}`])
  await applyInstallation(plan, { install: async () => { throw new Error('--no-install must not run a package manager') } })
  expect(await readFile(join(fixture.project, 'src/integrations/fixture/index.ts'), 'utf8')).toContain('fixturePipeline')
  expect(await readFile(join(fixture.project, '.env.example'), 'utf8')).toContain('FIXTURE_TOKEN=""')
  const repeated = await planInstallation({ cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, noInstall: true })
  expect(repeated.alreadyInstalled).toBe(false)
  expect(repeated.installRequired).toBe(true)
  expect(repeated.files).toEqual([])
  const complete = await planInstallation({ cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION })
  let installations = 0
  await applyInstallation(complete, { install: async (cwd) => { installations += 1; await installFixtureDependencies(cwd) } })
  expect(installations).toBe(1)
  const installed = await planInstallation({ cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION })
  expect(installed.alreadyInstalled).toBe(true)
  await applyInstallation(installed, { install: async () => { throw new Error('complete installs must be a no-op') } })
})

test.serial('schema projects preserve existing definitions, plugins, manifest fields and env values', async () => {
  const fixture = await fixtures.create()
  await write(join(fixture.project, 'clickhouse.config.ts'), `import { ingest as load } from '@chkit/plugin-ingest'
export default { schema: ['./db/**/*.ts'], plugins: [load({ journalTable: 'kept' })], clickhouse: { url: 'http://example' } }`)
  await write(join(fixture.project, 'package.json'), JSON.stringify({ name: 'kept', scripts: { custom: 'echo retained' }, packageManager: 'npm@11.0.0', devDependencies: { unrelated: '^1.0.0' } }))
  await write(join(fixture.project, '.env.example'), 'FIXTURE_TOKEN=existing\nOTHER=kept')
  const plan = await planInstallation({ cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, noInstall: true })
  expect(plan.packageManager).toBe('npm')
  await applyInstallation(plan)
  const config = await readFile(join(fixture.project, 'clickhouse.config.ts'), 'utf8')
  expect(config).toContain("'./db/**/*.ts'")
  expect(config).toContain("load({ journalTable: 'kept' })")
  const manifest = JSON.parse(await readFile(join(fixture.project, 'package.json'), 'utf8'))
  expect(manifest.scripts).toEqual({ custom: 'echo retained' })
  expect(manifest.devDependencies.unrelated).toBe('^1.0.0')
  const env = await readFile(join(fixture.project, '.env.example'), 'utf8')
  expect(env).toContain('FIXTURE_TOKEN=existing\nOTHER=kept\n')
  expect(env.match(/FIXTURE_TOKEN=/g)).toHaveLength(1)
})

test.serial('entry projects preserve exports and relocate provider code consistently', async () => {
  const fixture = await fixtures.create()
  await write(join(fixture.project, 'config/chkit.ts'), `export default { entry: './src/chkit.ts' }`)
  await write(join(fixture.project, 'src/chkit.ts'), `export { existingTable } from './existing.js'\n`)
  const plan = await planInstallation({ cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, configPath: 'config/chkit.ts', path: 'src/providers/demo', noInstall: true })
  await applyInstallation(plan)
  expect(await readFile(join(fixture.project, 'src/chkit.ts'), 'utf8')).toContain('export { fixtureRaw, fixturePipeline } from "./providers/demo/index.js"')
  expect(await readFile(join(fixture.project, 'src/chkit.ts'), 'utf8')).toContain("export { existingTable } from './existing.js'")
  expect(await readFile(join(fixture.project, 'src/providers/demo/index.ts'), 'utf8')).toContain("'./schema.js'")
})

test.serial('test files and development dependencies are opt-in and can be added to an existing install', async () => {
  const fixture = await fixtures.create(true)
  const input = { cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, path: 'src/providers/demo', noInstall: true }
  const defaultPlan = await planInstallation(input)
  expect(describePlan(defaultPlan).withTests).toBe(false)
  expect(defaultPlan.files.some((file) => file.path.includes('/tests/'))).toBe(false)
  expect(defaultPlan.dependencies).not.toContain('@types/bun@^1.3.0')
  await applyInstallation(defaultPlan)
  const packagePath = join(fixture.project, 'package.json')
  expect(JSON.parse(await readFile(packagePath, 'utf8')).devDependencies).not.toHaveProperty('@types/bun')

  const testPlan = await planInstallation({ ...input, withTests: true })
  expect(describePlan(testPlan).withTests).toBe(true)
  expect(testPlan.files.filter((file) => file.path.includes('/tests/'))).toHaveLength(2)
  expect(testPlan.dependencies).toEqual(['@types/bun@^1.3.0'])
  await applyInstallation(testPlan)
  expect(JSON.parse(await readFile(packagePath, 'utf8')).devDependencies['@types/bun']).toBe('^1.3.0')
  expect(await readFile(join(fixture.project, 'clickhouse.config.ts'), 'utf8')).not.toContain('tests/')
  const lock = JSON.parse(await readFile(join(fixture.project, '.chkit/registry-lock.json'), 'utf8'))
  expect(lock.items.fixture.withTests).toBe(true)
  expect(Object.keys(lock.items.fixture.files)).toContain('src/providers/demo/tests/fixture.test.ts')
  const repeated = await planInstallation(input)
  expect(repeated.withTests).toBe(true)
  expect(repeated.files).toEqual([])

  const child = Bun.spawn({ cmd: [process.execPath, 'test', 'src/providers/demo/tests'], cwd: fixture.project, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 })

  const testPath = join(fixture.project, 'src/providers/demo/tests/fixture.test.ts')
  await write(testPath, 'a local test edit')
  await expect(planInstallation(input)).rejects.toThrow('modified')
  expect(await readFile(testPath, 'utf8')).toBe('a local test edit')
})

test.serial('test dependency conflicts fail before any writes only when tests are selected', async () => {
  const fixture = await fixtures.create(true)
  const input = { cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION }
  const manifest = JSON.stringify({ devDependencies: { '@types/bun': '^99.0.0' } })
  await write(join(fixture.project, 'package.json'), manifest)
  expect((await planInstallation(input)).withTests).toBe(false)
  await expect(planInstallation({ ...input, withTests: true })).rejects.toThrow('Dependency conflict: @types/bun')
  expect(await readdir(fixture.project)).toEqual(['package.json'])
  expect(await readFile(join(fixture.project, 'package.json'), 'utf8')).toBe(manifest)
})

test.serial('opting into tests retries dependency setup and then remains an idempotent install', async () => {
  const fixture = await fixtures.create(true)
  const input = { cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, packageManager: 'bun' as const }
  await applyInstallation(await planInstallation(input), { install: installFixtureDependencies })
  expect((await planInstallation(input)).alreadyInstalled).toBe(true)
  const tests = await planInstallation({ ...input, withTests: true })
  expect(tests.installRequired).toBe(true)
  await expect(applyInstallation(tests, { install: async () => { throw new Error('test dependency installation failed') } })).rejects.toThrow('test dependency installation failed')
  const retry = await planInstallation(input)
  expect(retry.withTests).toBe(true)
  expect(retry.installRequired).toBe(true)
  expect(retry.files).toEqual([])
  let installs = 0
  await applyInstallation(retry, { install: async (cwd) => {
    installs += 1
    await write(join(cwd, 'node_modules/@types/bun/package.json'), JSON.stringify({ name: '@types/bun', version: '1.3.0' }))
  } })
  expect(installs).toBe(1)
  expect((await planInstallation(input)).alreadyInstalled).toBe(true)
  const lock = JSON.parse(await readFile(join(fixture.project, '.chkit/registry-lock.json'), 'utf8'))
  expect(lock.items.fixture).toMatchObject({ withTests: true, dependenciesInstalled: true })
})

test.serial('test files are protected from broad schema globs and conflicting local files', async () => {
  const fixture = await fixtures.create(true)
  const input = { cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, withTests: true }
  await write(join(fixture.project, 'clickhouse.config.ts'), `export default { schema: './src/**/tests/**/*.ts' }`)
  await expect(planInstallation(input)).rejects.toThrow('provider internals')
  await rm(join(fixture.project, 'clickhouse.config.ts'))
  const testPath = join(fixture.project, 'src/integrations/fixture/tests/fixture.test.ts')
  await write(testPath, 'existing user test')
  await expect(planInstallation(input)).rejects.toThrow('different content')
  expect(await readFile(testPath, 'utf8')).toBe('existing user test')
})

test.serial('reinstall preserves local modifications and intentional file deletion', async () => {
  const fixture = await fixtures.create()
  const input = { cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, noInstall: true }
  await applyInstallation(await planInstallation(input))
  const path = join(fixture.project, 'src/integrations/fixture/schema.ts')
  await write(path, 'a local edit')
  await expect(planInstallation(input)).rejects.toThrow('modified')
  expect(await readFile(path, 'utf8')).toBe('a local edit')
  await rm(path)
  await expect(planInstallation(input)).rejects.toThrow('deleted')
  await expect(readFile(path)).rejects.toThrow('ENOENT')
})

test.serial('conflicting files, export names and incompatible dependencies fail before writing', async () => {
  const fixture = await fixtures.create()
  const input = { cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, noInstall: true }
  const entry = join(fixture.project, 'src/integrations/fixture/index.ts')
  await write(entry, 'existing unrelated content')
  await expect(planInstallation(input)).rejects.toThrow('different content')
  await rm(entry)
  await write(join(fixture.project, 'clickhouse.config.ts'), `export default { entry: './src/chkit.ts' }`)
  await write(join(fixture.project, 'src/chkit.ts'), 'export const fixtureRaw = {}\n')
  await expect(planInstallation(input)).rejects.toThrow('already exported')
  await write(join(fixture.project, 'src/chkit.ts'), 'export const existing = {}\n')
  await write(join(fixture.project, 'package.json'), JSON.stringify({ dependencies: { '@chkit/core': '^99.0.0' } }))
  await expect(planInstallation(input)).rejects.toThrow('Dependency conflict')
  await expect(readFile(join(fixture.project, '.chkit/registry-lock.json'))).rejects.toThrow('ENOENT')
})

test.serial('installer calls the selected package manager after files exist and surfaces failures', async () => {
  const fixture = await fixtures.create()
  const plan = await planInstallation({ cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, packageManager: 'pnpm' })
  const failure = new Error('pnpm install failed; retry pnpm install')
  await expect(applyInstallation(plan, { install: async (cwd, pm) => {
    expect(cwd).toBe(fixture.project)
    expect(pm).toBe('pnpm')
    expect(await readFile(join(cwd, 'package.json'), 'utf8')).toContain('@chkit/plugin-ingest')
    throw failure
  } })).rejects.toThrow('pnpm install failed')
  expect(await readFile(join(fixture.project, 'src/integrations/fixture/index.ts'), 'utf8')).toContain('fixturePipeline')
  const retry = await planInstallation({ cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, packageManager: 'pnpm' })
  expect(retry.installRequired).toBe(true)
  expect(retry.files).toEqual([])
  await applyInstallation(retry, { install: installFixtureDependencies })
  const lock = JSON.parse(await readFile(join(fixture.project, '.chkit/registry-lock.json'), 'utf8'))
  expect(lock.items.fixture.dependenciesInstalled).toBe(true)
})

test.serial('an installed registry lock without local packages retries installation', async () => {
  const fixture = await fixtures.create()
  const input = { cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION }
  await applyInstallation(await planInstallation(input), { install: installFixtureDependencies })
  expect((await planInstallation(input)).alreadyInstalled).toBe(true)
  await write(join(fixture.project, 'node_modules/@chkit/core/package.json'), JSON.stringify({ name: '@chkit/core', version: '99.0.0', main: './index.js' }))
  expect((await planInstallation(input)).installRequired).toBe(true)
  await installFixtureDependencies(fixture.project)
  await rm(join(fixture.project, 'node_modules'), { recursive: true })
  const repeated = await planInstallation(input)
  expect(repeated.installRequired).toBe(true)
  expect(repeated.alreadyInstalled).toBe(false)
  let installations = 0
  await applyInstallation(repeated, { install: async (cwd) => { installations += 1; await installFixtureDependencies(cwd) } })
  expect(installations).toBe(1)
  expect((await planInstallation(input)).alreadyInstalled).toBe(true)
})

test.serial('explicit CLI and core dependency ranges must fit registry compatibility metadata', async () => {
  const fixture = await fixtures.create()
  const input = { cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION }
  await expect(planInstallation({ ...input, item: { ...fixture.item, dependencies: [...fixture.item.dependencies, 'chkit@99.0.0'] } })).rejects.toThrow('outside the template compatibility range')
  await expect(planInstallation({ ...input, item: { ...fixture.item, dependencies: ['@chkit/core@99.0.0', ...fixture.item.dependencies.slice(1)] } })).rejects.toThrow('outside the template compatibility range')
  expect(await readdir(fixture.project)).toEqual([])
})

test.serial('broad schema globs fail before writing provider files', async () => {
  const fixture = await fixtures.create()
  await write(join(fixture.project, 'clickhouse.config.ts'), `export default { schema: './src/**/*.ts' }`)
  await expect(planInstallation({ cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION })).rejects.toThrow('provider internals')
  await expect(readFile(join(fixture.project, 'src/integrations/fixture/index.ts'))).rejects.toThrow('ENOENT')
})

test.serial('planning and application reject symlinks and edits made after planning', async () => {
  const fixture = await fixtures.create()
  const input = { cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, noInstall: true }
  const plan = await planInstallation(input)
  const config = join(fixture.project, 'clickhouse.config.ts')
  await write(config, 'changed after planning')
  await expect(applyInstallation(plan)).rejects.toThrow('changed since planning')
  await expect(readFile(join(fixture.project, 'src/integrations/fixture/index.ts'))).rejects.toThrow('ENOENT')
  await rm(config)
  await symlink(fixture.source, join(fixture.project, 'src'))
  await expect(planInstallation(input)).rejects.toThrow('symlink')
})

test.serial('template and CLI incompatibility, ambiguous package managers and changed origins are rejected', async () => {
  const fixture = await fixtures.create()
  const input = { cwd: fixture.project, item: fixture.item, origin: fixture.origin, cliVersion: FIXTURE_VERSION, noInstall: true }
  await expect(planInstallation({ ...input, cliVersion: '1.0.0' })).rejects.toThrow('requires chkit')
  await write(join(fixture.project, 'bun.lock'), '{}')
  await write(join(fixture.project, 'package-lock.json'), '{}')
  await expect(planInstallation(input)).rejects.toThrow('Multiple package-manager lockfiles')
  await applyInstallation(await planInstallation({ ...input, packageManager: 'bun' }))
  await expect(planInstallation({ ...input, origin: `${fixture.origin}?different` })).rejects.toThrow('already installed')
})
