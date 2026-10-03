#!/usr/bin/env bun
import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRegistryCatalog } from '../packages/cli/src/registry/build.js'
import { readRegistrySourceCatalog } from './registry-catalog.js'

if (import.meta.main) {
  const result = await buildOfficialRegistry()
  console.log(`Built ${result.items.length} registry item(s) into apps/docs/public/r/.`)
}

export async function buildOfficialRegistry(input: { registryRoot?: string; outputDir?: string } = {}) {
  const registryRoot = input.registryRoot ?? fileURLToPath(new URL('../registry/', import.meta.url))
  const outputDir = input.outputDir ?? fileURLToPath(new URL('../apps/docs/public/r/', import.meta.url))
  const catalog = await readRegistrySourceCatalog(registryRoot)

  // Historical releases keep pinned URLs alive; a new provider has no history yet.
  // The builder rejects changes to an already published name/version pair.
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  for (const item of catalog.items) {
    await cp(join(registryRoot, item.name, 'releases'), join(outputDir, item.name), { recursive: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    })
  }
  return buildRegistryCatalog({ catalog, sourceRoot: registryRoot, outputDir })
}
