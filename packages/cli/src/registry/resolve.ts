import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { DEFAULT_REGISTRY, MAX_ARTIFACT_BYTES, parseRegistryCatalog, parseRegistryItem, type RegistryCatalog, type RegistryItem } from './model.js'

const GITHUB_REGISTRY_API = 'https://api.github.com/repos/obsessiondb/chkit/contents/registry?ref=main'
const GITHUB_REGISTRY_RAW = 'https://raw.githubusercontent.com/obsessiondb/chkit/main/registry/'
const GITHUB_CATALOG_HOME = 'https://chkit.obsessiondb.com'

export async function resolveRegistryItem(reference: string, registry = DEFAULT_REGISTRY): Promise<{ item: RegistryItem; origin: string }> {
  if (registry === DEFAULT_REGISTRY && !isDirectReference(reference)) return resolveGitHubItem(reference)
  let origin: string
  let expectedName: string | undefined
  let expectedVersion: string | undefined
  if (isDirectReference(reference)) {
    origin = isHttp(reference) ? reference : resolve(reference)
  } else {
    const match = /^([a-z][a-z0-9-]*)(?:@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))?$/.exec(reference)
    const name = match?.[1]
    const version = match?.[2]
    if (!name) throw new Error(`Invalid template reference: ${reference}`)
    expectedName = name
    expectedVersion = version
    const catalogLocation = registryLocation(registry)
    const path = version ? `${name}/${version}.json` : `${name}.json`
    origin = isHttp(catalogLocation) ? new URL(path, catalogLocation).href : resolve(dirname(catalogLocation), path)
  }
  const item = parseRegistryItem(await readJson(origin))
  if (expectedName !== undefined && item.name !== expectedName) throw new Error(`Registry returned ${item.name} for requested template ${expectedName}`)
  if (expectedVersion !== undefined && item.meta.chkit.version !== expectedVersion) throw new Error(`Registry returned version ${item.meta.chkit.version} for requested version ${expectedVersion}`)
  return { item, origin }
}

export async function readRegistryCatalog(registry = DEFAULT_REGISTRY): Promise<RegistryCatalog> {
  if (registry === DEFAULT_REGISTRY) return readGitHubCatalog()
  return parseRegistryCatalog(await readJson(registryLocation(registry)))
}

async function resolveGitHubItem(reference: string): Promise<{ item: RegistryItem; origin: string }> {
  const match = /^([a-z][a-z0-9-]*)(?:@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))?$/.exec(reference)
  const name = match?.[1]
  if (!name) throw new Error(`Invalid template reference: ${reference}`)
  let version = match?.[2]
  if (!version) {
    const manifest = parseRegistryItem(await readJson(`${GITHUB_REGISTRY_RAW}${name}/manifest.json`), false)
    if (manifest.name !== name) throw new Error(`Registry returned ${manifest.name} for requested template ${name}`)
    version = manifest.meta.chkit.version
  }
  const origin = `${GITHUB_REGISTRY_RAW}${name}/releases/${version}.json`
  const item = parseRegistryItem(await readJson(origin))
  if (item.name !== name) throw new Error(`Registry returned ${item.name} for requested template ${name}`)
  if (item.meta.chkit.version !== version) throw new Error(`Registry returned version ${item.meta.chkit.version} for requested version ${version}`)
  return { item, origin }
}

async function readGitHubCatalog(): Promise<RegistryCatalog> {
  const listing: unknown = await readJson(GITHUB_REGISTRY_API)
  if (!Array.isArray(listing)) throw new Error('GitHub registry directory response is not an array')
  const names = listing.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('type' in entry) || entry.type !== 'dir' || !('name' in entry)) return []
    const name = entry.name
    return typeof name === 'string' && /^[a-z][a-z0-9-]*$/.test(name) ? [name] : []
  }).sort()
  const items = await Promise.all(names.map(async (name) => {
    const item = parseRegistryItem(await readJson(`${GITHUB_REGISTRY_RAW}${name}/manifest.json`), false)
    if (item.name !== name) throw new Error(`Registry folder ${name} does not match manifest name ${item.name}`)
    return { ...item, files: item.files.map((file) => ({ ...file, path: `${name}/${file.path}` })) }
  }))
  return parseRegistryCatalog({ name: 'chkit', homepage: GITHUB_CATALOG_HOME, items })
}

function registryLocation(registry: string): string {
  if (isHttp(registry)) {
    const url = new URL(registry)
    if (!url.pathname.endsWith('.json')) url.pathname = `${url.pathname.replace(/\/$/, '')}/registry.json`
    return url.href
  }
  return resolve(registry, registry.endsWith('.json') ? '' : 'registry.json')
}

function isDirectReference(reference: string): boolean {
  return isHttp(reference) || reference.endsWith('.json') || reference.startsWith('.') || reference.startsWith('/')
}

async function readJson(location: string): Promise<unknown> {
  if (!isHttp(location)) {
    if ((await stat(location)).size > MAX_ARTIFACT_BYTES) throw new Error('Registry artifact exceeds the 8 MiB limit')
    return JSON.parse(await readFile(location, 'utf8'))
  }
  const url = new URL(location)
  if (url.username || url.password) throw new Error('Credentials in registry URLs are not supported')
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000), redirect: 'error',
    ...(url.hostname === 'api.github.com' ? { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } } : {}),
  })
  if (!response.ok) throw new Error(`Registry request failed (${response.status}): ${url.origin}${url.pathname}`)
  if (!response.body) throw new Error('Registry response is empty')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_ARTIFACT_BYTES) throw new Error('Registry artifact exceeds the 8 MiB limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isHttp(value: string): boolean {
  return /^https?:\/\//.test(value)
}
