import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { TranslatedEndpoint } from '../src/index.js'

/** The part of a generated query the parity check uses: its own param validation. */
export interface GeneratedQuery {
  params: { parse(input: unknown): Record<string, unknown> }
}

/**
 * Writes the generated queries module and imports it, so the parity check
 * calls each endpoint's query the way users do. `coreEntry` replaces the
 * `@chkit/core` import when the module lives outside the workspace.
 */
export async function loadGeneratedQueries(
  queriesSource: string,
  dir: string,
  coreEntry?: string
): Promise<Record<string, GeneratedQuery>> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'queries.ts')
  await writeFile(file, coreEntry ? queriesSource.replace("from '@chkit/core'", `from ${JSON.stringify(coreEntry)}`) : queriesSource)
  return (await import(pathToFileURL(file).href)) as Record<string, GeneratedQuery>
}

/**
 * The SQL ClickHouse runs for an imported endpoint called with `params` (URL
 * param strings, as Tinybird receives them). The values go through the
 * generated query's own `params` (types, defaults, the float transform), as a
 * caller's would; every `{name:String}` placeholder then becomes the String
 * literal ClickHouse substitutes for the value @clickhouse/client sends.
 * Parity compares this with Tinybird's own rendering.
 */
function renderEndpointSql(endpoint: TranslatedEndpoint, query: GeneratedQuery, params: Record<string, string>): string {
  const parsed = query.params.parse(callValues(endpoint, params))
  return endpoint.sql.replace(/\{([A-Za-z_][A-Za-z0-9_]*):String\}/g, (_placeholder, name: string) => {
    const value = parsed[name]
    if (value === undefined || value === null) throw new Error(`${endpoint.pipe}: the query gave no value for param ${name}`)
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  })
}

/** URL param strings as the TypeScript values a caller passes: numbers for numeric params, BigInt beyond 2^53. */
export function callValues(endpoint: TranslatedEndpoint, params: Record<string, string>): Record<string, unknown> {
  const types = new Map(endpoint.params.map((param) => [param.name, param.type]))
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => {
      const type = types.get(name) ?? ''
      if (/^U?Int/.test(type)) return [name, Number.isSafeInteger(Number(value)) ? Number(value) : BigInt(value)]
      if (/^Float/.test(type)) return [name, Number(value)]
      return [name, value]
    })
  )
}

/**
 * Every param set of every endpoint, bound through its generated query. A set
 * the query rejects is left out, so the comparison reports the endpoint as
 * different ("no chkit render for params ...").
 */
export function renderEndpoints(
  endpoints: TranslatedEndpoint[],
  queries: Record<string, GeneratedQuery>
): Map<string, Array<{ params: Record<string, string>; sql: string }>> {
  return new Map(
    endpoints.map((endpoint) => {
      const query = queries[endpoint.exportName]
      const renders = endpoint.paramSets.flatMap((params) => {
        if (!query) return []
        try {
          return [{ params, sql: renderEndpointSql(endpoint, query, params) }]
        } catch {
          return []
        }
      })
      return [endpoint.pipe, renders]
    })
  )
}
