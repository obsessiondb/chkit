import type { Datafile, DatafileNode } from './datafile.js'
import type { PipeScope } from './pipes.js'
import type { Translation } from './report.js'

/** Tinybird endpoints → chkit typed queries. Not translated yet: every endpoint is reported. */
export interface TranslatedEndpoint {
  pipe: string
  exportName: string
  /** The query module source for this endpoint. */
  source: string
  /** The SQL chkit sends, with `{name:String}` placeholders. */
  sql: string
  params: EndpointParam[]
  /** Param sets the parity check renders on both sides (Tinybird URL params). */
  paramSets: Array<Record<string, string>>
}

export interface EndpointParam {
  name: string
  type: string
  default?: string | number
  required: boolean
}

export function translateEndpoint(_file: Datafile, _output: DatafileNode | undefined, _scope: PipeScope): Translation<TranslatedEndpoint> {
  return { ok: false, reasons: ['endpoints are not translated yet'] }
}

export function renderQueriesFile(endpoints: TranslatedEndpoint[], database: string): string {
  return `// Imported from Tinybird endpoints, reading database ${database}.\n${endpoints.map((endpoint) => endpoint.source).join('\n\n')}\n`
}
