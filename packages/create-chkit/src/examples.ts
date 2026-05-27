import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ExampleEntry = {
  name: string
  description: string
}

type ExamplesManifest = {
  default: string
  examples: ExampleEntry[]
}

const MANIFEST = loadManifest()

export const EXAMPLES: ReadonlyArray<ExampleEntry> = MANIFEST.examples
export const DEFAULT_EXAMPLE: string = MANIFEST.default

function loadManifest(): ExamplesManifest {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'manifest.json'),
    join(here, '..', '..', '..', 'examples', 'manifest.json'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, 'utf8')
      return JSON.parse(raw) as ExamplesManifest
    }
  }
  throw new Error(
    `create-chkit: examples manifest not found. Looked in:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  )
}
