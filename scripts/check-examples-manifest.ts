#!/usr/bin/env bun
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

type Manifest = {
  default: string
  examples: { name: string; description: string }[]
}

const here = dirname(fileURLToPath(import.meta.url))
const examplesDir = resolve(here, '..', 'examples')
const manifestPath = resolve(examplesDir, 'manifest.json')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest

const dirNames = readdirSync(examplesDir)
  .filter((entry) => statSync(resolve(examplesDir, entry)).isDirectory())
  .sort()

const manifestNames = manifest.examples.map((entry) => entry.name).sort()

const missingFromManifest = dirNames.filter((name) => !manifestNames.includes(name))
const missingFromDisk = manifestNames.filter((name) => !dirNames.includes(name))
const defaultMissing = !manifestNames.includes(manifest.default)

const errors: string[] = []

if (missingFromManifest.length > 0) {
  errors.push(
    `Directories under examples/ are missing from manifest.json:\n${missingFromManifest.map((n) => `  - ${n}`).join('\n')}`,
  )
}

if (missingFromDisk.length > 0) {
  errors.push(
    `manifest.json lists examples with no matching directory under examples/:\n${missingFromDisk.map((n) => `  - ${n}`).join('\n')}`,
  )
}

if (defaultMissing) {
  errors.push(
    `manifest.json default "${manifest.default}" does not match any entry in examples[].`,
  )
}

if (errors.length > 0) {
  console.error('examples/manifest.json is out of sync:\n')
  for (const error of errors) console.error(`${error}\n`)
  console.error('Edit examples/manifest.json so it matches the contents of examples/.')
  process.exit(1)
}

console.log(`examples/manifest.json is in sync (${manifestNames.length} example(s)).`)
