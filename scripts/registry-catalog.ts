import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CATALOG_SCHEMA_URL, parseRegistryCatalog, parseRegistryItem, type RegistryCatalog } from '../packages/cli/src/registry/model.js'

// Each provider owns its manifest; the public catalog is assembled at build time.
export async function readRegistrySourceCatalog(
  registryRoot = fileURLToPath(new URL('../registry/', import.meta.url)),
): Promise<RegistryCatalog> {
  const directories = (await readdir(registryRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => entry.name).sort()
  const items = await Promise.all(directories.map(async (directory) => {
    const item = parseRegistryItem(JSON.parse(await readFile(join(registryRoot, directory, 'manifest.json'), 'utf8')), false)
    if (item.name !== directory) throw new Error(`Registry folder ${directory} must match manifest name ${item.name}`)
    return { ...item, files: item.files.map((file) => ({ ...file, path: `${directory}/${file.path}` })) }
  }))
  return parseRegistryCatalog({
    $schema: CATALOG_SCHEMA_URL,
    name: 'chkit',
    homepage: 'https://chkit.obsessiondb.com',
    items,
  })
}
