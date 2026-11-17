import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { type Datafile, type DatafileNode, parseDatafile } from './datafile.js'

/** What a pipe is, from the `TYPE` of its typed node (Tinybird allows one). */
export type PipeType = 'materialized' | 'copy' | 'endpoint' | 'sink' | 'default' | 'other'

export interface TinybirdProject {
  /** Absolute path of the folder the datafiles were read from. */
  dir: string
  datasources: Datafile[]
  pipes: Array<{ file: Datafile; type: PipeType; output: DatafileNode | undefined }>
  /** Files found but not translated (connections, includes), relative to `dir`. */
  otherFiles: string[]
  /** Datafiles Tinybird does not build as part of this workspace, with the reason. */
  ignoredFiles: Array<{ path: string; reason: string }>
}

/**
 * The scan depth of `tb build`: the Forward CLI's `--max-depth` defaults to 3,
 * so `<folder>/*.ext` to `<folder>/*\/*\/*.ext` (`Project.get_files`).
 */
export const DEFAULT_MAX_DEPTH = 3
const PIPE_TYPES: Record<string, PipeType> = {
  materialized: 'materialized',
  copy: 'copy',
  endpoint: 'endpoint',
  sink: 'sink',
  default: 'default',
}

/**
 * Reads the datafiles `tb build --max-depth <maxDepth>` reads
 * (`Project.get_project_files`). Every other datafile in the folder is listed
 * in `ignoredFiles` with the reason, never dropped silently: files deeper
 * than `maxDepth`, files under a top-level entry whose name starts with
 * `vendor` (Tinybird excludes by the substring `<folder>/vendor`; vendored
 * datasources belong to other workspaces), and hidden files and folders,
 * which Python's glob does not match. Only `.git` is not walked.
 */
export async function readProject(projectDir: string, options: { maxDepth?: number } = {}): Promise<TinybirdProject> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error(`maxDepth must be a positive integer, got ${maxDepth}`)
  const base = resolve(projectDir)
  const dir = resolve(base, await configuredFolder(base))
  const walked: Walk = { files: [], unreadable: [], visited: new Set() }
  await walk(dir, walked)
  const paths = walked.files.sort()
  const datasources: Datafile[] = []
  const pipes: TinybirdProject['pipes'] = []
  const otherFiles: string[] = []
  const ignoredFiles: TinybirdProject['ignoredFiles'] = walked.unreadable.map((path) => ({
    path: relative(dir, path),
    reason: 'not readable: the importer could not list this folder (Tinybird skips it too), so datafiles in it are not imported',
  }))
  const names = new Map<string, string>()

  for (const path of paths) {
    const relativePath = relative(dir, path)
    const segments = relativePath.split(sep)
    // Connection and include files are listed first: INCLUDE reads its file by path, whatever its depth.
    if (!path.endsWith('.datasource') && !path.endsWith('.pipe')) {
      otherFiles.push(relativePath)
      continue
    }
    if (segments.some((segment) => segment.startsWith('.'))) {
      ignoredFiles.push({ path: relativePath, reason: 'hidden: Tinybird does not read hidden files or folders' })
      continue
    }
    if (segments[0]?.startsWith('vendor')) {
      ignoredFiles.push({ path: relativePath, reason: 'vendored: Tinybird excludes everything under <folder>/vendor* from the workspace (other workspaces\' datasources)' })
      continue
    }
    if (segments.length > maxDepth) {
      ignoredFiles.push({
        path: relativePath,
        reason: `deeper than the scan depth ${maxDepth} (tb --max-depth ${maxDepth}), so Tinybird does not build it; raise maxDepth if the project is built with a higher --max-depth`,
      })
      continue
    }
    const file = parseDatafile(relativePath, await readFile(path, 'utf8'))
    const seen = names.get(file.name)
    if (seen) throw new Error(`Tinybird resource ${file.name} is defined twice: ${seen} and ${relativePath}`)
    names.set(file.name, relativePath)
    if (file.kind === 'datasource') {
      datasources.push(file)
      continue
    }
    const typed = file.nodes.find((node) => node.vars.has('TYPE'))
    const typeName = typed?.vars.get('TYPE')?.toLowerCase() ?? 'default'
    const type = PIPE_TYPES[typeName] ?? 'other'
    pipes.push({ file, type, output: typed ?? file.nodes.at(-1) })
  }
  return { dir, datasources, pipes, otherFiles, ignoredFiles }
}

/** `tinybird.config.json` may point the datafiles to a subfolder. */
async function configuredFolder(base: string): Promise<string> {
  const config = await readFile(join(base, 'tinybird.config.json'), 'utf8').catch(() => undefined)
  if (!config) return '.'
  const parsed: unknown = JSON.parse(config)
  const folder = typeof parsed === 'object' && parsed !== null && 'folder' in parsed ? parsed.folder : undefined
  return typeof folder === 'string' && folder.trim() ? folder : '.'
}

interface Walk {
  files: string[]
  /** Folders the walk could not list (EACCES, EPERM). */
  unreadable: string[]
  /** Real paths of the folders walked, so a symlink loop is walked once. */
  visited: Set<string>
}

const DATAFILE = /\.(datasource|pipe|connection|incl)$/

/**
 * Every datafile under `dir`, following symlinks to folders as Python's glob
 * does. A folder that cannot be listed is recorded, not fatal: Tinybird's glob
 * skips it too. Only `.git` is not walked.
 */
async function walk(dir: string, into: Walk): Promise<void> {
  const real = await realpath(dir).catch(() => dir)
  if (into.visited.has(real)) return
  into.visited.add(real)
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      into.unreadable.push(dir)
      return
    }
    throw error
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(path).then((target) => target.isDirectory(), () => false)))
      if (isDirectory) {
        if (entry.name !== '.git') await walk(path, into)
      } else if (DATAFILE.test(entry.name)) into.files.push(path)
    })
  )
}
