#!/usr/bin/env bun
import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildRegistry } from '../packages/cli/src/registry/build.js'

const manifestPath = fileURLToPath(new URL('../registry/registry.json', import.meta.url))
const releasesDir = fileURLToPath(new URL('../registry/releases/', import.meta.url))
const outputDir = fileURLToPath(new URL('../apps/docs/public/r/', import.meta.url))

// Historical releases are committed so a clean deployment keeps pinned URLs alive.
// The builder rejects changes to an already published name/version pair.
await rm(outputDir, { recursive: true, force: true })
await mkdir(outputDir, { recursive: true })
await cp(releasesDir, outputDir, { recursive: true })

const result = await buildRegistry({ manifestPath, outputDir })
console.log(`Built ${result.items.length} registry item(s) into apps/docs/public/r/.`)
