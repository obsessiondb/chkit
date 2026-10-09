import { afterEach, expect, test } from 'bun:test'

import { DEFAULT_REGISTRY } from '../../registry/model.js'
import { readRegistryCatalog, resolveRegistryItem } from '../../registry/resolve.js'
import { fixtureTracker } from './fixtures.js'

const fixtures = fixtureTracker()
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  await fixtures.cleanup()
})

test.serial('the default registry lists GitHub manifests and installs committed release artifacts', async () => {
  const fixture = await fixtures.create()
  const manifest = {
    ...fixture.sourceItem,
    files: fixture.sourceItem.files.map((file) => ({ ...file, path: file.path.slice('fixture/'.length) })),
  }
  const requests: string[] = []
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input))
    requests.push(url.href)
    if (url.pathname === '/repos/obsessiondb/chkit/contents/registry') {
      return Response.json([{ name: 'fixture', type: 'dir' }, { name: 'package.json', type: 'file' }])
    }
    if (url.pathname === '/obsessiondb/chkit/main/registry/fixture/manifest.json') return Response.json(manifest)
    if (url.pathname === '/obsessiondb/chkit/main/registry/fixture/releases/1.0.0.json') return Response.json(fixture.item)
    return new Response('Not found', { status: 404 })
  }, { preconnect: originalFetch.preconnect })

  expect(DEFAULT_REGISTRY).toBe('github:obsessiondb/chkit')
  const catalog = await readRegistryCatalog()
  expect(catalog.items.map((item) => item.name)).toEqual(['fixture'])
  expect(catalog.items[0]?.files.map((file) => file.path)).toEqual(fixture.sourceItem.files.map((file) => file.path))
  const latest = await resolveRegistryItem('fixture')
  const pinned = await resolveRegistryItem('fixture@1.0.0')
  expect(latest).toEqual(pinned)
  expect(latest.item).toEqual(fixture.item)
  expect(latest.origin).toBe('https://raw.githubusercontent.com/obsessiondb/chkit/main/registry/fixture/releases/1.0.0.json')
  expect(requests).toEqual([
    'https://api.github.com/repos/obsessiondb/chkit/contents/registry?ref=main',
    'https://raw.githubusercontent.com/obsessiondb/chkit/main/registry/fixture/manifest.json',
    'https://raw.githubusercontent.com/obsessiondb/chkit/main/registry/fixture/manifest.json',
    'https://raw.githubusercontent.com/obsessiondb/chkit/main/registry/fixture/releases/1.0.0.json',
    'https://raw.githubusercontent.com/obsessiondb/chkit/main/registry/fixture/releases/1.0.0.json',
  ])
})
