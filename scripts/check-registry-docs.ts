#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { YAML } from 'bun'
import { type RegistryCatalog, parseRegistryCatalog } from '../packages/cli/src/registry/model.js'

interface DocsPaths {
  docsDir: string
  publicDir: string
}

// Run with `bun scripts/check-registry-docs.ts`; the docs build runs this automatically.
// Each official app needs a canonical guide, SEO metadata, documented resources, and local logo assets.
if (import.meta.main) {
  const repoDir = fileURLToPath(new URL('../', import.meta.url))
  const catalog = parseRegistryCatalog(JSON.parse(readFileSync(join(repoDir, 'registry/registry.json'), 'utf8')))
  const errors = checkRegistryDocs(catalog, {
    docsDir: join(repoDir, 'apps/docs/src/content/docs'),
    publicDir: join(repoDir, 'apps/docs/public'),
  })
  if (errors.length > 0) {
    console.error(`Registry documentation is out of sync:\n${errors.map((error) => `  - ${error}`).join('\n')}`)
    process.exitCode = 1
  } else {
    console.log(`Registry documentation is in sync (${catalog.items.length} app(s)).`)
  }
}

export function checkRegistryDocs(catalog: RegistryCatalog, paths: DocsPaths): string[] {
  return catalog.items.flatMap((item) => {
    const errors: string[] = []
    const metadata = item.meta.chkit
    const canonicalUrl = new URL(`/integrations/${item.name}/`, catalog.homepage).href
    if (metadata.documentation !== canonicalUrl) {
      errors.push(`${item.name}: meta.chkit.documentation must be ${canonicalUrl}.`)
    }

    const candidates = ['md', 'mdx'].map((extension) => join(paths.docsDir, 'integrations', `${item.name}.${extension}`))
    const guides = candidates.filter(isFile)
    if (guides.length !== 1) {
      errors.push(`${item.name}: expected one guide at integrations/${item.name}.md or .mdx; found ${guides.length}.`)
    } else {
      const guide = guides[0]
      if (guide) errors.push(...checkGuide(guide, item.title, metadata.resources.map((resource) => resource.name), paths.docsDir))
    }

    if (metadata.logo) {
      const logo = new URL(metadata.logo)
      if (logo.origin !== new URL(catalog.homepage).origin || logo.search || logo.hash) {
        errors.push(`${item.name}: meta.chkit.logo must point to a local asset on ${new URL(catalog.homepage).origin}.`)
      } else if (!isFile(join(paths.publicDir, logo.pathname))) {
        errors.push(`${item.name}: logo asset apps/docs/public${logo.pathname} does not exist.`)
      }
    }
    return errors
  })
}

function checkGuide(path: string, appTitle: string, resources: string[], docsDir: string): string[] {
  const label = relative(docsDir, path)
  const source = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (!match?.[1]) return [`${label}: missing YAML frontmatter with title and description.`]

  let frontmatter: unknown
  try {
    frontmatter = YAML.parse(match[1])
  } catch (error) {
    return [`${label}: invalid YAML frontmatter (${error instanceof Error ? error.message : String(error)}).`]
  }
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    return [`${label}: frontmatter must contain title and description fields.`]
  }

  const errors: string[] = []
  const expectedTitle = `Integrating ClickHouse with ${appTitle}`
  if (!('title' in frontmatter) || frontmatter.title !== expectedTitle) {
    errors.push(`${label}: frontmatter title must be "${expectedTitle}".`)
  }
  if (!('description' in frontmatter) || typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
    errors.push(`${label}: frontmatter description must be a non-empty string.`)
  }

  const body = source.slice(match[0].length)
  for (const resource of resources) {
    if (!body.includes(`\`${resource}\``)) {
      errors.push(`${label}: document the registry resource \`${resource}\` in the guide body.`)
    }
  }
  return errors
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}
