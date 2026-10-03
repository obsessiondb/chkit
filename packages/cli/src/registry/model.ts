import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { valid, validRange } from 'semver'
import { z } from 'zod'

export const ITEM_SCHEMA_URL = 'https://ui.shadcn.com/schema/registry-item.json'
export const CATALOG_SCHEMA_URL = 'https://ui.shadcn.com/schema/registry.json'
export const DEFAULT_REGISTRY = 'https://chkit.obsessiondb.com/r/registry.json'
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024

const relativePath = z.string().min(1).refine(isSafeRelativePath, 'Expected a normalized project-relative path')
const version = z.string().refine((value) => valid(value) === value, 'Expected a semantic version')
const versionRange = z.string().min(1).refine((value) => validRange(value) !== null, 'Expected a semantic version range')
const identifier = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
const dependency = z.string().refine((value) => parseDependency(value) !== undefined, 'Expected package@semver-range')
const webUrl = z.url({ protocol: /^https?$/ })

const metadataSchema = z.object({
  formatVersion: z.literal(1),
  version,
  language: z.literal('typescript'),
  license: z.string().min(1),
  documentation: webUrl.optional(),
  logo: webUrl.optional(),
  authentication: z.object({
    method: z.string().min(1),
    env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).min(1),
    setup: z.array(z.string().min(1)).min(1),
    documentation: webUrl,
  }).strict().optional(),
  chkit: versionRange,
  ingest: versionRange,
  clickhouse: versionRange,
  root: relativePath,
  entry: relativePath,
  exports: z.array(identifier).min(1),
  resources: z.array(z.object({
    name: z.string().min(1),
    title: z.string().min(1).optional(),
    table: z.string().min(1).optional(),
    description: z.string().min(1),
    scopes: z.array(z.string()),
    strategy: z.literal('full'),
    endpoints: z.array(z.object({
      method: z.enum(['GET', 'POST']),
      path: z.string().startsWith('/'),
      documentation: webUrl,
    }).strict()).optional(),
  }).strict()).min(1),
  views: z.array(z.object({
    name: z.string().min(1), source: z.string().min(1), description: z.string().min(1),
  }).strict()).optional(),
  sync: z.object({
    description: z.string().min(1), schedule: z.string().min(1), deletions: z.string().min(1),
  }).strict().optional(),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().refine((value) => !/[\r\n\0]/.test(value))),
  fileHashes: z.record(relativePath, z.string().regex(/^[a-f0-9]{64}$/)).optional(),
}).strict()

const registryItemSchema = z.object({
  $schema: z.literal(ITEM_SCHEMA_URL).optional(),
  name: z.string().regex(/^[a-z][a-z0-9-]*$/).refine((value) => value !== 'registry', 'Item name registry is reserved for the catalog'),
  type: z.literal('registry:item'),
  title: z.string().min(1),
  description: z.string().min(1),
  dependencies: z.array(dependency).min(1),
  devDependencies: z.array(dependency).optional(),
  registryDependencies: z.array(z.string()).max(0, 'Registry dependencies are not supported in format version 1').optional(),
  files: z.array(z.object({
    path: relativePath,
    type: z.literal('registry:file'),
    target: relativePath,
    role: z.literal('test').optional(),
    content: z.string().optional(),
  }).strict()).min(1).max(200),
  meta: z.object({ chkit: metadataSchema }).strict(),
}).strict()

const registryCatalogSchema = z.object({
  $schema: z.literal(CATALOG_SCHEMA_URL).optional(),
  name: z.string().min(1),
  homepage: z.url(),
  items: z.array(registryItemSchema),
}).strict()

export type RegistryItem = z.infer<typeof registryItemSchema>
export type RegistryCatalog = z.infer<typeof registryCatalogSchema>

export function parseRegistryItem(value: unknown, built = true): RegistryItem {
  const item = registryItemSchema.parse(value)
  const meta = item.meta.chkit
  const targets = new Set<string>()
  for (const file of item.files) {
    if (!file.target.startsWith(`${meta.root}/`)) throw new Error(`File target ${file.target} must be inside ${meta.root}/`)
    if (targets.has(file.target)) throw new Error(`Duplicate registry target: ${file.target}`)
    targets.add(file.target)
    if (built && file.content === undefined) throw new Error(`Missing built content for ${file.target}. Run chkit registry build first.`)
    if (built && meta.fileHashes?.[file.target] !== hashContent(file.content ?? '')) {
      throw new Error(`Registry content hash does not match: ${file.target}`)
    }
  }
  if (!targets.has(posix.join(meta.root, meta.entry))) throw new Error(`Entry ${meta.entry} is not included in the item`)
  if (item.files.find((file) => file.target === posix.join(meta.root, meta.entry))?.role === 'test') throw new Error('Registry entry cannot be a test file')
  if (new Set(meta.exports).size !== meta.exports.length) throw new Error('Duplicate registry export names')
  const names = item.dependencies.map((spec) => requireDependency(spec).name)
  if (new Set(names).size !== names.length) throw new Error('Duplicate package dependencies')
  const allNames = [...names, ...(item.devDependencies ?? []).map((spec) => requireDependency(spec).name)]
  if (new Set(allNames).size !== allNames.length) throw new Error('Duplicate package dependencies across dependencies and devDependencies')
  for (const required of ['@chkit/core', '@chkit/plugin-ingest']) {
    if (!names.includes(required)) throw new Error(`Registry item must declare ${required} as a dependency`)
  }
  return item
}

export function parseRegistryCatalog(value: unknown): RegistryCatalog {
  const catalog = registryCatalogSchema.parse(value)
  const seen = new Set<string>()
  for (const item of catalog.items) {
    parseRegistryItem(item, false)
    if (seen.has(item.name)) throw new Error(`Duplicate registry item: ${item.name}`)
    seen.add(item.name)
  }
  return catalog
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !/[\\:]/.test(value) && ![...value].some((character) => character.charCodeAt(0) < 32) && !value.startsWith('/') &&
    !value.startsWith('~') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git' && part !== 'node_modules')
}

export function requireDependency(value: string): { name: string; range: string } {
  const parsed = parseDependency(value)
  if (!parsed) throw new Error(`Unsupported dependency ${value}; use package@semver-range`)
  return parsed
}

function parseDependency(value: string): { name: string; range: string } | undefined {
  const match = /^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]*)@(.+)$/.exec(value)
  const name = match?.[1]
  const range = match?.[2]
  if (!name || !range || !validRange(range)) return undefined
  return { name, range }
}
