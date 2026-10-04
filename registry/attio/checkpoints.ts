import { cursorState, IngestConfigError, type ReadContext } from '@chkit/plugin-ingest'

import { attioConfig } from './config.js'

export interface ScanParent {
  workspaceId: string
  id: string
  slug: string
}

export interface AttioScanState {
  scope: string
  cycle: number
  phase: 'scanning' | 'complete'
  parents: readonly ScanParent[]
  completedParents: readonly string[]
}

export type AttioReadContext = ReadContext<AttioScanState | undefined, AttioScanState>

/** Full scans have completion checkpoints, never an inferred modification watermark. */
export function scanCheckpoint(resource: string) {
  return cursorState<AttioScanState>({ id: `attio.scan.${resource}`, version: 1, parse: parseScanState })
}

export function beginScan(context: AttioReadContext, resource: string): AttioScanState {
  const parents = ['objects', 'object_attributes', 'records'].includes(resource) ? attioConfig.objects
    : ['lists', 'list_attributes', 'entries'].includes(resource) ? attioConfig.lists : undefined
  const scope = JSON.stringify([attioConfig.sourceId, resource, parents === undefined ? null : [...new Set(parents)].sort()])
  if (context.state && context.state.scope !== scope) {
    throw new IngestConfigError('Attio checkpoint scope changed. Restore the parent selection or use a new sourceId for a deliberate fresh scan.')
  }
  if (context.state?.phase === 'scanning') return context.state
  const cycle = (context.state?.cycle ?? 0) + 1
  if (!Number.isSafeInteger(cycle)) throw new IngestConfigError('Attio scan cycle exceeded the safe integer range.')
  return { scope, cycle, phase: 'scanning', parents: [], completedParents: [] }
}

function parseScanState(raw: unknown): AttioScanState {
  if (!isObject(raw) || typeof raw.scope !== 'string' || typeof raw.cycle !== 'number'
    || !Number.isSafeInteger(raw.cycle) || raw.cycle < 1 || (raw.phase !== 'scanning' && raw.phase !== 'complete')
    || !Array.isArray(raw.parents) || !raw.parents.every(isParent)
    || !Array.isArray(raw.completedParents) || !raw.completedParents.every((id): id is string => typeof id === 'string')) {
    throw new IngestConfigError('Invalid Attio scan checkpoint.')
  }
  const ids = raw.parents.map((parent) => parent.id)
  if (new Set(ids).size !== ids.length || new Set(raw.completedParents).size !== raw.completedParents.length
    || raw.completedParents.some((id) => !ids.includes(id))) {
    throw new IngestConfigError('Invalid Attio scan checkpoint parent frontier.')
  }
  return { scope: raw.scope, cycle: raw.cycle, phase: raw.phase, parents: raw.parents, completedParents: raw.completedParents }
}

function isParent(value: unknown): value is ScanParent {
  return isObject(value) && [value.workspaceId, value.id, value.slug].every((part) => typeof part === 'string' && part.length > 0)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
