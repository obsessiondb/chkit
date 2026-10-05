import { afterEach, expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { buildRegistry } from '../../registry/build.js'
import { fixtureTracker, write, writeManifest } from './fixtures.js'

const CLI_ENTRY = resolve(import.meta.dir, '../../bin/chkit.ts')
const fixtures = fixtureTracker()
const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await fixtures.cleanup()
})

test.serial('registry and add help work outside a project', async () => {
  const fixture = await fixtures.create()
  const [add, registry] = await Promise.all([
    runCli(fixture.project, ['add', '--help']),
    runCli(fixture.project, ['registry', '--help']),
  ])
  expect(add.exitCode).toBe(0)
  expect(add.stdout).toContain('chkit add <name[@version]|URL|local.json>')
  expect(add.stdout).toContain('--dry-run')
  expect(add.stdout).toContain('--with-tests')
  expect(add.stdout).toContain('Browse apps with chkit registry list')
  expect(registry.exitCode).toBe(0)
  expect(registry.stdout).toContain('chkit registry <command>')
  expect(registry.stdout).toContain('inspect <template>')
  expect(registry.stdout).toContain('https://chkit.obsessiondb.com/integrations/')
  expect(await readdir(fixture.project)).toEqual([])
})

test.serial('unknown flags emit parseable JSON errors before resolving a template', async () => {
  const fixture = await fixtures.create()
  const [add, registry] = await Promise.all([
    runCli(fixture.project, ['add', 'fixture', '--not-a-real-flag', '--json']),
    runCli(fixture.project, ['registry', 'list', '--not-a-real-flag', '--json']),
  ])
  for (const [command, result] of [['add', add], ['registry', registry]] as const) {
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      command, schemaVersion: 1, ok: false,
      error: { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' },
    })
    expect(result.stderr).toContain('--not-a-real-flag')
  }
  expect(await readdir(fixture.project)).toEqual([])
})

test.serial('build, list and inspect roundtrip through the CLI without importing project config', async () => {
  const fixture = await fixtures.create()
  await write(join(fixture.project, 'clickhouse.config.ts'), "throw new Error('registry commands must not import this config')\n")
  const output = join(fixture.root, 'cli-output')
  const built = await runCli(fixture.project, ['registry', 'build', fixture.manifest, '--output', output, '--json'])
  expect(built.exitCode).toBe(0)
  expect(JSON.parse(built.stdout)).toEqual({
    command: 'registry', schemaVersion: 1, ok: true, action: 'build', items: ['fixture@1.0.0'],
    files: [join(output, 'fixture/1.0.0.json'), join(output, 'fixture.json'), join(output, 'registry.json')],
  })
  const listed = await runCli(fixture.project, ['registry', 'list', '--registry', output, '--json'])
  expect(listed.exitCode).toBe(0)
  expect(JSON.parse(listed.stdout)).toEqual({
    command: 'registry', schemaVersion: 1, ok: true, action: 'list',
    items: [{
      name: 'fixture', title: 'Fixture', description: 'A provider fixture', version: '1.0.0',
      resourceCount: 1, resources: fixture.item.meta.chkit.resources, strategies: ['full'],
    }],
  })
  const [pinned, direct] = await Promise.all([
    runCli(fixture.project, ['registry', 'inspect', 'fixture@1.0.0', '--registry', join(output, 'registry.json'), '--json']),
    runCli(fixture.project, ['registry', 'inspect', join(output, 'fixture.json'), '--json']),
  ])
  expect(pinned.exitCode).toBe(0)
  expect(JSON.parse(pinned.stdout)).toEqual({
    command: 'registry', schemaVersion: 1, ok: true, action: 'inspect',
    origin: join(output, 'fixture/1.0.0.json'), item: fixture.item,
  })
  expect(direct.exitCode).toBe(0)
  expect(JSON.parse(direct.stdout).item).toEqual(fixture.item)

  const [listText, inspectText] = await Promise.all([
    runCli(fixture.project, ['registry', 'list', '--registry', output]),
    runCli(fixture.project, ['registry', 'inspect', 'fixture', '--registry', output]),
  ])
  expect(listText.exitCode).toBe(0)
  expect(listText.stdout).toContain('Fixture (fixture@1.0.0)')
  expect(listText.stdout).toContain('1 resource; sync strategies: full')
  expect(listText.stdout).toContain(`Install: chkit add fixture@1.0.0 --registry ${output}`)
  expect(listText.stdout).not.toContain('Guide:')
  expect(inspectText.exitCode).toBe(0)
  expect(inspectText.stdout).toContain('FIXTURE_TOKEN: empty placeholder; configure before syncing')
  expect(inspectText.stdout).toContain('records: Fixture records')
  expect(inspectText.stdout).toContain('Table: see source schema')
  expect(inspectText.stdout).not.toContain('Table: records')
  expect(inspectText.stdout).toContain('Strategy: full (full scans); scopes: record:read')
  expect(inspectText.stdout).not.toContain('Guide:')
  expect(inspectText.stdout).not.toContain('Logo:')
  expect(inspectText.stdout).not.toContain('Changelog:')
})

test.serial('inspect shows the integration changelog in human and JSON output', async () => {
  const fixture = await fixtures.create()
  const changelog = [
    { version: '1.0.1', changes: ['Resume interrupted syncs from saved cursors.', 'Keep provider payloads unchanged.'] },
    { version: '1.0.0', changes: ['Add the initial integration.'] },
  ]
  await writeManifest(fixture.manifest, {
    ...fixture.sourceItem,
    meta: { chkit: { ...fixture.sourceItem.meta.chkit, version: '1.0.1', changelog } },
  })
  await buildRegistry({ manifestPath: fixture.manifest, outputDir: fixture.output })
  const [human, json, legacy] = await Promise.all([
    runCli(fixture.project, ['registry', 'inspect', 'fixture@1.0.1', '--registry', fixture.output]),
    runCli(fixture.project, ['registry', 'inspect', 'fixture@1.0.1', '--registry', fixture.output, '--json']),
    runCli(fixture.project, ['registry', 'inspect', 'fixture@1.0.0', '--registry', fixture.output]),
  ])
  expect(human.exitCode).toBe(0)
  expect(human.stdout).toContain('Changelog:\n  1.0.1\n    - Resume interrupted syncs from saved cursors.\n    - Keep provider payloads unchanged.\n  1.0.0\n    - Add the initial integration.')
  expect(json.exitCode).toBe(0)
  expect(JSON.parse(json.stdout).item.meta.chkit.changelog).toEqual(changelog)
  expect(legacy.exitCode).toBe(0)
  expect(legacy.stdout).not.toContain('Changelog:')
  expect(await readdir(fixture.project)).toEqual([])
})

test.serial('list and inspect expose integration guides, logos, complete resources and environment defaults', async () => {
  const fixture = await fixtures.create()
  const documentation = 'https://example.com/registry/fixture/'
  const logo = 'https://example.com/logos/fixture.svg'
  const resources = [
    ...fixture.sourceItem.meta.chkit.resources.map((resource) => ({ ...resource, strategy: 'timestamp' as const })),
    { name: 'members', description: 'Workspace members', scopes: ['members:read', 'workspace:read'], strategy: 'cursor' as const },
  ]
  await writeManifest(fixture.manifest, {
    ...fixture.sourceItem,
    meta: { chkit: {
      ...fixture.sourceItem.meta.chkit,
      version: '1.0.1', documentation, logo, resources,
      env: { FIXTURE_TOKEN: '', FIXTURE_REGION: 'eu' },
    } },
  })
  await buildRegistry({ manifestPath: fixture.manifest, outputDir: fixture.output })

  const [listJson, inspectJson, listText, inspectText] = await Promise.all([
    runCli(fixture.project, ['registry', 'list', '--registry', fixture.output, '--json']),
    runCli(fixture.project, ['registry', 'inspect', 'fixture@1.0.1', '--registry', fixture.output, '--json']),
    runCli(fixture.project, ['registry', 'list', '--registry', fixture.output]),
    runCli(fixture.project, ['registry', 'inspect', 'fixture@1.0.1', '--registry', fixture.output]),
  ])
  expect(listJson.exitCode).toBe(0)
  expect(JSON.parse(listJson.stdout)).toEqual({
    command: 'registry', schemaVersion: 1, ok: true, action: 'list',
    items: [{
      name: 'fixture', title: 'Fixture', description: 'A provider fixture', version: '1.0.1',
      resourceCount: 2, resources, strategies: ['timestamp', 'cursor'], documentation, logo,
    }],
  })
  expect(inspectJson.exitCode).toBe(0)
  expect(JSON.parse(inspectJson.stdout)).toMatchObject({
    command: 'registry', schemaVersion: 1, ok: true, action: 'inspect',
    origin: join(fixture.output, 'fixture/1.0.1.json'),
    item: { meta: { chkit: { version: '1.0.1', documentation, logo, resources, env: { FIXTURE_TOKEN: '', FIXTURE_REGION: 'eu' } } } },
  })
  expect(listText.exitCode).toBe(0)
  expect(listText.stdout).toContain('Fixture (fixture@1.0.1)')
  expect(listText.stdout).toContain('2 resources; sync strategies: timestamp (timestamp windows), cursor (cursor checkpoints)')
  expect(listText.stdout).toContain(`Guide: ${documentation}`)
  expect(listText.stdout).toContain(`Install: chkit add fixture@1.0.1 --registry ${fixture.output}`)
  expect(inspectText.exitCode).toBe(0)
  expect(inspectText.stdout).toContain(`Guide: ${documentation}`)
  expect(inspectText.stdout).toContain(`Logo: ${logo}`)
  expect(inspectText.stdout).toContain(`Install: chkit add fixture@1.0.1 --registry ${fixture.output}`)
  expect(inspectText.stdout).toContain('members: Workspace members')
  expect(inspectText.stdout).toContain('Strategy: cursor (cursor checkpoints); scopes: members:read, workspace:read')
  expect(inspectText.stdout).toContain('FIXTURE_REGION: "eu"')
  expect(await readdir(fixture.project)).toEqual([])

  const installed = await runCli(fixture.project, ['add', 'fixture@1.0.1', '--registry', fixture.output, '--no-install', '--package-manager', 'bun'])
  expect(installed.exitCode).toBe(0)
  expect(installed.stdout).toContain(`Integration guide: ${documentation}`)
  expect(installed.stdout).not.toContain('Fixture tests:')
})

test.serial('add dry-run stays read-only and no-install writes the selected provider path', async () => {
  const fixture = await fixtures.create()
  const args = ['add', 'fixture@1.0.0', '--registry', fixture.output, '--path', 'src/providers/fixture', '--no-install', '--package-manager', 'bun', '--json']
  const preview = await runCli(fixture.project, [...args, '--dry-run'])
  expect(preview.exitCode).toBe(0)
  expect(JSON.parse(preview.stdout)).toMatchObject({
    command: 'add', schemaVersion: 1, ok: true, dryRun: true,
    template: { name: 'fixture', version: '1.0.0', origin: join(fixture.output, 'fixture/1.0.0.json') },
    packageManager: 'bun', noInstall: true, alreadyInstalled: false, installRequired: true,
  })
  expect(await readdir(fixture.project)).toEqual([])

  const installed = await runCli(fixture.project, [...args, '--yes'])
  expect(installed.exitCode).toBe(0)
  expect(JSON.parse(installed.stdout)).toMatchObject({ command: 'add', ok: true, dryRun: false, noInstall: true })
  expect(await readFile(join(fixture.project, 'src/providers/fixture/index.ts'), 'utf8')).toContain('fixturePipeline')
  expect(await readFile(join(fixture.project, 'clickhouse.config.ts'), 'utf8')).toContain('./src/providers/fixture/index.ts')
  expect(await readFile(join(fixture.project, '.env.example'), 'utf8')).toContain('FIXTURE_TOKEN=""')
  expect(JSON.parse(await readFile(join(fixture.project, '.chkit/registry-lock.json'), 'utf8')).items.fixture.dependenciesInstalled).toBe(false)
})

test.serial('add --with-tests previews and installs runnable fixtures at a custom path', async () => {
  const fixture = await fixtures.create(true)
  const args = ['add', 'fixture', '--registry', fixture.output, '--path', 'src/providers/demo', '--no-install', '--with-tests', '--package-manager', 'bun', '--json']
  const preview = await runCli(fixture.project, [...args, '--dry-run'])
  expect(preview.exitCode).toBe(0)
  const planned = JSON.parse(preview.stdout)
  expect(planned).toMatchObject({ ok: true, dryRun: true, withTests: true })
  expect(planned.dependencies).toContain('@types/bun@^1.3.0')
  expect(planned.files).toContainEqual(expect.objectContaining({ path: 'src/providers/demo/tests/fixture.test.ts', action: 'create' }))
  expect(await readdir(fixture.project)).toEqual([])
  const installed = await runCli(fixture.project, args)
  expect(installed.exitCode).toBe(0)
  expect(JSON.parse(installed.stdout)).toMatchObject({ ok: true, dryRun: false, withTests: true })
  expect(await readFile(join(fixture.project, 'src/providers/demo/tests/fixture.test.ts'), 'utf8')).toContain("'../schema.js'")
  expect(await readFile(join(fixture.project, 'clickhouse.config.ts'), 'utf8')).toContain('./src/providers/demo/index.ts')
  expect(await readFile(join(fixture.project, 'clickhouse.config.ts'), 'utf8')).not.toContain('tests/')
})

test.serial('inspect explains authentication, synced tables, endpoints, views and optional tests', async () => {
  const fixture = await fixtures.create(true)
  const authentication = {
    method: 'Bearer API token', env: ['FIXTURE_TOKEN'], setup: ['Open workspace settings.', 'Create a read-only token.'], documentation: 'https://example.com/auth',
  }
  const resources = [{
    name: 'records', title: 'Records', table: 'fixture_raw', description: 'All accessible records', scopes: ['record:read'], strategy: 'full' as const,
    endpoints: [{ method: 'POST' as const, path: '/records/query', documentation: 'https://example.com/records' }],
  }]
  const views = [{ name: 'fixture_people', source: 'fixture_raw', description: 'People only' }]
  const sync = { description: 'Read every page.', schedule: 'Every hour.', deletions: 'Retain deleted records.' }
  await writeManifest(fixture.manifest, { ...fixture.sourceItem, meta: { chkit: { ...fixture.sourceItem.meta.chkit, version: '1.0.1', authentication, resources, views, sync } } })
  await buildRegistry({ manifestPath: fixture.manifest, outputDir: fixture.output })
  const [human, json] = await Promise.all([
    runCli(fixture.project, ['registry', 'inspect', 'fixture', '--registry', fixture.output]),
    runCli(fixture.project, ['registry', 'inspect', 'fixture', '--registry', fixture.output, '--json']),
  ])
  expect(human.exitCode).toBe(0)
  expect(human.stdout).toContain('Authentication: Bearer API token')
  expect(human.stdout).toContain('1. Open workspace settings.')
  expect(human.stdout).toContain('Provider guide: https://example.com/auth')
  expect(human.stdout).toContain('Default table: fixture_raw')
  expect(human.stdout).toContain('POST /records/query (https://example.com/records)')
  expect(human.stdout).toContain('fixture_people (from fixture_raw): People only')
  expect(human.stdout).toContain('Deletions: Retain deleted records.')
  expect(human.stdout).toContain('fixture.test.ts (optional; --with-tests)')
  expect(human.stdout).toContain('Test dependencies (--with-tests): @types/bun@^1.3.0')
  expect(json.exitCode).toBe(0)
  expect(JSON.parse(json.stdout).item.meta.chkit).toMatchObject({ authentication, resources, views, sync })
  expect(await readdir(fixture.project)).toEqual([])
})

test.serial('HTTP catalogs, named pins and item URLs resolve in asynchronous CLI subprocesses', async () => {
  const fixture = await fixtures.create()
  const routes = new Map(await Promise.all(['registry.json', 'fixture.json', 'fixture/1.0.0.json'].map(async (path) => [
    `/r/${path}`, await readFile(join(fixture.output, path), 'utf8'),
  ] as const)))
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(path)
      const content = routes.get(path)
      return content === undefined
        ? new Response('Not found', { status: 404 })
        : new Response(content, { headers: { 'Content-Type': 'application/json' } })
    },
  })
  servers.push(server)
  const registry = new URL('/r/', server.url).href
  const artifact = new URL('fixture/1.0.0.json', registry).href
  const [listed, latest, pinned, direct, preview] = await Promise.all([
    runCli(fixture.project, ['registry', 'list', '--registry', registry, '--json']),
    runCli(fixture.project, ['registry', 'inspect', 'fixture', '--registry', registry, '--json']),
    runCli(fixture.project, ['registry', 'inspect', 'fixture@1.0.0', '--registry', registry, '--json']),
    runCli(fixture.project, ['registry', 'inspect', artifact, '--json']),
    runCli(fixture.project, ['add', artifact, '--dry-run', '--no-install', '--json']),
  ])
  expect(listed.exitCode).toBe(0)
  expect(JSON.parse(listed.stdout).items).toHaveLength(1)
  expect(latest.exitCode).toBe(0)
  expect(JSON.parse(latest.stdout).origin).toBe(new URL('fixture.json', registry).href)
  expect(pinned.exitCode).toBe(0)
  expect(JSON.parse(pinned.stdout).origin).toBe(artifact)
  expect(direct.exitCode).toBe(0)
  expect(JSON.parse(direct.stdout).item).toEqual(fixture.item)
  expect(preview.exitCode).toBe(0)
  expect(JSON.parse(preview.stdout)).toMatchObject({ ok: true, dryRun: true, template: { origin: artifact } })
  expect(requests.sort()).toEqual(['/r/fixture.json', '/r/fixture/1.0.0.json', '/r/fixture/1.0.0.json', '/r/fixture/1.0.0.json', '/r/registry.json'].sort())
  expect(await readdir(fixture.project)).toEqual([])
})

async function runCli(cwd: string, args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args], cwd,
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 10_000,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  return { stdout, stderr, exitCode }
}
