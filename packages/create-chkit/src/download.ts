import { downloadTemplate } from 'giget'

import { CREATE_CHKIT_VERSION } from './version.js'

const DEFAULT_REPO = 'obsessiondb/chkit'

export function resolveExampleSource(example: string): string {
  if (looksLikeUrl(example) || hasProviderPrefix(example)) return example
  return `github:${DEFAULT_REPO}/examples/${example}#${defaultRef()}`
}

function defaultRef(): string {
  return `create-chkit@${CREATE_CHKIT_VERSION}`
}

export async function downloadExample(example: string, targetDir: string): Promise<{ source: string }> {
  const source = resolveExampleSource(example)
  await downloadTemplate(source, {
    dir: targetDir,
    force: true,
  })
  return { source }
}

function looksLikeUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://')
}

function hasProviderPrefix(value: string): boolean {
  return /^(github|gh|gitlab|bitbucket|sourcehut):/i.test(value)
}
