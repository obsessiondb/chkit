import { readdir, readFile } from 'node:fs/promises'
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
 * Tinybird's project scan (`Project.get_project_files`): `<folder>/*.ext` and
 * `<folder>/*\/*.ext` only (max_depth 2), without `<folder>/vendor`, which holds
 * other workspaces' datasources. Deeper folders are walked only to report
 * their datafiles; these are never descended into.
 */
const MAX_DEPTH = 2
const NOT_WALKED = new Set(['node_modules', 'venv'])
const PIPE_TYPES: Record<string, PipeType> = {
  materialized: 'materialized',
  copy: 'copy',
  endpoint: 'endpoint',
  sink: 'sink',
  default: 'default',
}

export async function readProject(projectDir: string): Promise<TinybirdProject> {
  const base = resolve(projectDir)
  const dir = resolve(base, await configuredFolder(base))
  const paths = (await walk(dir)).sort()
  const datasources: Datafile[] = []
  const pipes: TinybirdProject['pipes'] = []
  const otherFiles: string[] = []
  const ignoredFiles: TinybirdProject['ignoredFiles'] = []
  const names = new Map<string, string>()

  for (const path of paths) {
    const relativePath = relative(dir, path)
    const segments = relativePath.split(sep)
    if (segments[0] === 'vendor' && segments.length > 1) {
      ignoredFiles.push({ path: relativePath, reason: 'vendored: a datasource of another workspace, which Tinybird builds as that workspace' })
      continue
    }
    if (segments.length > MAX_DEPTH) {
      ignoredFiles.push({ path: relativePath, reason: `deeper than the ${MAX_DEPTH} folder levels Tinybird scans, so Tinybird does not build it` })
      continue
    }
    if (!path.endsWith('.datasource') && !path.endsWith('.pipe')) {
      otherFiles.push(relativePath)
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

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name.startsWith('.') || NOT_WALKED.has(entry.name) ? [] : walk(path)
      return /\.(datasource|pipe|connection|incl)$/.test(entry.name) ? [path] : []
    })
  )
  return nested.flat()
}
