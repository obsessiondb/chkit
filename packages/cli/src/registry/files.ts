import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Reject symlinks even within the project: installation should never write through one. */
export async function assertProjectPath(root: string, path: string): Promise<void> {
  const absoluteRoot = resolve(root)
  const absolutePath = resolve(path)
  const suffix = relative(absoluteRoot, absolutePath)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`Path must stay inside the project: ${path}`)
  }
  let current = absoluteRoot
  for (const part of suffix.split(sep)) {
    current = resolve(current, part)
    const stat = await lstat(current).catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    if (stat?.isSymbolicLink()) throw new Error(`Refusing a symlink in registry path: ${current}`)
  }
}

export async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
