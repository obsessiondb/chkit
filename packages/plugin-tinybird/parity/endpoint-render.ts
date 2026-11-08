import { isFloat } from '../src/endpoints.js'
import type { TranslatedEndpoint } from '../src/index.js'
import { pythonFloat } from '../src/python-float.js'

/**
 * The SQL ClickHouse runs for an imported endpoint called with `params` (URL
 * param strings, as Tinybird receives them): every `{name:String}` placeholder
 * becomes the String literal ClickHouse substitutes for it, the param's value
 * or its default (a float formatted as the generated query formats it). Parity then compares this with Tinybird's own rendering.
 */
export function renderEndpointSql(endpoint: TranslatedEndpoint, params: Record<string, string>): string {
  const byName = new Map(endpoint.params.map((param) => [param.name, param]))
  return endpoint.sql.replace(/\{([A-Za-z_][A-Za-z0-9_]*):String\}/g, (_placeholder, name: string) => {
    const value = params[name] ?? (byName.get(name)?.default !== undefined ? String(byName.get(name)?.default) : undefined)
    if (value === undefined) throw new Error(`${endpoint.pipe}: no value for required param ${name}`)
    // chkit sends a float through the generated pythonFloat transform.
    if (isFloat(byName.get(name)?.type ?? '')) return `'${pythonFloat(Number(value))}'`
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  })
}
