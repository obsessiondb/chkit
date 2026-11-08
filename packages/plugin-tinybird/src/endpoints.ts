import type { Datafile, DatafileNode } from './datafile.js'
import type { PipeScope } from './pipes.js'
import type { Translation } from './report.js'
import { PYTHON_FLOAT_SOURCE } from './python-float.js'
import { resolveNode, SqlResolveError } from './sql-resolve.js'

/**
 * Tinybird endpoints → chkit typed queries (`query` + `p`).
 *
 * Tinybird renders a typed template param into the SQL it sends to ClickHouse
 * (observed with `/v0/pipes/<pipe>/explain` on Tinybird Local):
 * `{{ String(x, 'a') }}` → `'a'`, `{{ Int32(x, 100) }}` → `toInt32('100')`,
 * `{{ Date(x, '2024-02-18') }}` → `'2024-02-18'` (a String literal). The
 * translation binds every param as a ClickHouse `String` inside the same
 * function, `toInt32({x:String})`, so the query ClickHouse runs is the one
 * Tinybird runs, while `p` still validates the TypeScript value as the type.
 *
 * Anything else (control flow, `defined()`, `column()`, `Array()`, `Boolean()`,
 * params with neither a default nor `required=True`, ...) is reported, per
 * endpoint, as not translated.
 */
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
  /** The Tinybird type function: String, Int32, Date, ... */
  type: string
  default?: string | number
  required: boolean
}

interface ParamKind {
  /** The `t` builder of the TypeScript value. */
  schema: string
  /** The ClickHouse function Tinybird wraps the value in, if any. */
  cast?: string
  /** Pattern a String value must match, as a regex source. */
  pattern?: keyof typeof PATTERNS
  sample: string
}

const PATTERNS = {
  DATE: String.raw`^\d{4}-\d{2}-\d{2}$`,
  DATE_TIME: String.raw`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`,
  DATE_TIME64: String.raw`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$`,
} as const

/** The template param types whose rendering was verified against Tinybird Local. */
const PARAM_KINDS: Record<string, ParamKind> = {
  String: { schema: 't.string()', sample: 'chkit' },
  Int8: { schema: 't.int8()', cast: 'toInt8', sample: '-7' },
  Int16: { schema: 't.int16()', cast: 'toInt16', sample: '-7' },
  Int32: { schema: 't.int32()', cast: 'toInt32', sample: '-7' },
  Int64: { schema: 't.int64()', cast: 'toInt64', sample: '-7' },
  UInt8: { schema: 't.uint8()', cast: 'toUInt8', sample: '7' },
  UInt16: { schema: 't.uint16()', cast: 'toUInt16', sample: '7' },
  UInt32: { schema: 't.uint32()', cast: 'toUInt32', sample: '7' },
  UInt64: { schema: 't.uint64()', cast: 'toUInt64', sample: '7' },
  Float32: { schema: 't.float32()', cast: 'toFloat32', sample: '1.5' },
  Float64: { schema: 't.float64()', cast: 'toFloat64', sample: '1.5' },
  Date: { schema: 't.string()', pattern: 'DATE', sample: '2025-01-02' },
  DateTime: { schema: 't.string()', pattern: 'DATE_TIME', sample: '2025-01-02 03:04:05' },
  DateTime64: { schema: 't.string()', pattern: 'DATE_TIME64', sample: '2025-01-02 03:04:05.678' },
}

const TEMPLATE_TAG = /\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}|\{#([\s\S]*?)#\}/g
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*):String\}/g

export function translateEndpoint(file: Datafile, output: DatafileNode | undefined, scope: PipeScope): Translation<TranslatedEndpoint> {
  if (!output) return { ok: false, reasons: ['the endpoint has no nodes'] }
  const params = new Map<string, EndpointParam>()
  const reasons: string[] = []
  const nodes = new Map<string, string>()
  for (const node of file.nodes) {
    const rendered = renderTemplate(node.sql ?? '', params)
    if (rendered.ok) nodes.set(node.name, rendered.value)
    else reasons.push(...rendered.reasons.map((reason) => `node ${node.name}: ${reason}`))
  }
  if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)] }

  let sql: string
  try {
    sql = resolveNode(output.name, { ...scope, nodes }).sql
  } catch (error) {
    if (error instanceof SqlResolveError) return { ok: false, reasons: [`node ${output.name}: ${error.message}`] }
    throw error
  }
  const used = [...params.values()].filter((param) => sql.includes(`{${param.name}:String}`))
  const exportName = identifier(file.name)
  return {
    ok: true,
    value: {
      pipe: file.name,
      exportName,
      sql,
      params: used,
      source: renderEndpoint(file.name, exportName, sql, params),
      paramSets: paramSets(used),
    },
    notes: used.length > 0 ? [`params: ${used.map((param) => `${param.name} (${param.type}${param.required ? ', required' : ''})`).join(', ')}`] : [],
  }
}

export function renderQueriesFile(endpoints: TranslatedEndpoint[], database: string): string {
  const patterns = Object.keys(PATTERNS).filter((key) => endpoints.some((endpoint) => endpoint.source.includes(`.regex(${key})`))) as Array<keyof typeof PATTERNS>
  const lines = [
    `import { p, query, t } from '@chkit/core'`,
    '',
    `// Imported from Tinybird endpoints by chkit plugin tinybird import, reading database ${database}.`,
    '// Every param binds as a ClickHouse String inside the function Tinybird wraps it in, e.g.',
    "// toInt32({limit:String}), so ClickHouse runs the SQL Tinybird runs; p still validates its type.",
    '// Floats are sent as Python formats them (1 → 1.0), as Tinybird renders them.',
    '',
    ...patterns.map((key) => `const ${key} = /${PATTERNS[key]}/`),
    ...(patterns.length > 0 ? [''] : []),
    ...(endpoints.some((endpoint) => endpoint.params.some((param) => isFloat(param.type))) ? [PYTHON_FLOAT_SOURCE, ''] : []),
    endpoints.map((endpoint) => endpoint.source).join('\n\n'),
  ]
  return `${lines.join('\n')}\n`
}

/** The node's SQL with every template param replaced by a `{name:String}` placeholder (inside its cast). */
function renderTemplate(sql: string, params: Map<string, EndpointParam>): Translation<string> {
  const templated = sql.startsWith('%')
  const body = templated ? sql.slice(1).replace(/^[ \t]*\r?\n/, '') : sql
  const reasons: string[] = []
  const rendered = body.replace(TEMPLATE_TAG, (tag, expression: string | undefined, statement: string | undefined) => {
    if (!templated) {
      reasons.push('template syntax without the % marker line, which Tinybird does not render')
      return tag
    }
    if (expression === undefined) {
      if (statement !== undefined && /^\s*(end|else)\s*$/.test(statement)) return tag
      reasons.push(statement !== undefined ? `control flow {%${statement}%} has no static chkit query equivalent` : 'template comments are not translated')
      return tag
    }
    const param = parseParam(expression.trim())
    if (!param.ok) {
      reasons.push(...param.reasons)
      return tag
    }
    // A required param's default is only Tinybird's sample: a call without the param fails.
    const seen = params.get(param.value.name)
    const differs = (a: EndpointParam, b: EndpointParam) => a.type !== b.type || a.required !== b.required || (!a.required && a.default !== b.default)
    if (seen && differs(seen, param.value)) {
      reasons.push(`param ${param.value.name} is declared twice with different types or defaults`)
      return tag
    }
    if (!seen) params.set(param.value.name, param.value)
    const kind = PARAM_KINDS[param.value.type]
    const placeholder = `{${param.value.name}:String}`
    return kind?.cast ? `${kind.cast}(${placeholder})` : placeholder
  })
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, value: rendered, notes: [] }
}

/** `Type(name[, default][, required=True][, description='...'][, example='...'])`. */
function parseParam(expression: string): Translation<EndpointParam> {
  const call = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/.exec(expression)
  if (!call) return { ok: false, reasons: [`template expression {{ ${expression} }} is not a typed param`] }
  const [, type = '', argText = ''] = call
  if (!PARAM_KINDS[type]) return { ok: false, reasons: [`template function ${type}() is not translated`] }
  const args = splitArgs(argText)
  if (!args) return { ok: false, reasons: [`cannot read the arguments of {{ ${expression} }}`] }
  const [nameArg, ...rest] = args
  if (!nameArg || nameArg.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(nameArg.value)) {
    return { ok: false, reasons: [`{{ ${expression} }} does not name its param`] }
  }
  let defaultValue: string | number | undefined
  let required = false
  for (const [index, arg] of rest.entries()) {
    const key = arg.key ?? (index === 0 ? 'default' : undefined)
    if (key === 'default') {
      const literal = pythonLiteral(arg.value)
      if (literal === undefined) return { ok: false, reasons: [`the default of ${nameArg.value} is not a literal`] }
      defaultValue = literal
    } else if (key === 'required') {
      if (!/^(True|true|False|false)$/.test(arg.value)) return { ok: false, reasons: [`required=${arg.value} of ${nameArg.value} is not a boolean`] }
      required = /^(True|true)$/.test(arg.value)
    } else if (key !== 'description' && key !== 'example') {
      return { ok: false, reasons: [`argument ${key ?? arg.value} of ${type}(${nameArg.value}) is not translated`] }
    }
  }
  if (defaultValue === undefined && !required) {
    return { ok: false, reasons: [`param ${nameArg.value} has neither a default nor required=True; Tinybird's rendering of a missing value is not reproduced`] }
  }
  const kind = PARAM_KINDS[type]
  if (typeof defaultValue === 'string' && kind?.cast && !/^-?\d+(?:\.\d+)?$/.test(defaultValue)) {
    return { ok: false, reasons: [`the default '${defaultValue}' of ${nameArg.value} is not a number`] }
  }
  return { ok: true, value: { name: nameArg.value, type, required, ...(defaultValue !== undefined ? { default: normalizeDefault(defaultValue, kind) } : {}) }, notes: [] }
}

function normalizeDefault(value: string | number, kind: ParamKind | undefined): string | number {
  if (kind?.cast) return Number(value)
  return String(value)
}

/** Top-level comma-separated call arguments, `key=value` or positional. */
function splitArgs(text: string): Array<{ key?: string; value: string }> | undefined {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    if (quote) {
      current += char
      if (char === '\\') current += text[++i] ?? ''
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (quote || depth !== 0) return undefined
  if (current.trim()) parts.push(current.trim())
  return parts.map((part) => {
    const keyed = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(part)
    return keyed ? { key: keyed[1], value: (keyed[2] ?? '').trim() } : { value: part }
  })
}

/** A Python string or number literal, as Tinybird's template sees it. */
function pythonLiteral(text: string): string | number | undefined {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text)
  if (quoted) return (quoted[2] ?? '').replace(/\\(['"\\])/g, '$1')
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return undefined
}

function renderEndpoint(pipe: string, exportName: string, sql: string, params: ReadonlyMap<string, EndpointParam>): string {
  const body = escapeTemplate(sql).replace(PLACEHOLDER, (placeholder, name: string) => {
    const param = params.get(name)
    return param ? `\${${paramSource(param)}}` : placeholder
  })
  return `export const ${exportName} = query({ name: ${JSON.stringify(pipe)} })\`\n${body}\n\``
}

function paramSource(param: EndpointParam): string {
  const kind = PARAM_KINDS[param.type]
  if (!kind) throw new Error(`no param kind for ${param.type}`)
  const float = isFloat(param.type)
  // A float is sent as Python formats it; prefault runs the default through that transform too.
  const schema = `${kind.schema}${kind.pattern ? `.regex(${kind.pattern})` : ''}${kind.cast ? `.meta({ clickhouse: 'String' })` : ''}${float ? '.transform(pythonFloat)' : ''}`
  const value = `p(${JSON.stringify(param.name)}, ${schema})`
  if (param.required || param.default === undefined) return value
  return `${value}.${float ? 'prefault' : 'default'}(${JSON.stringify(param.default)})`
}

export function isFloat(type: string): boolean {
  return type === 'Float32' || type === 'Float64'
}

/** Text for a JavaScript template literal: backslashes, backticks and `${` are escaped. */
function escapeTemplate(sql: string): string {
  return sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/** The defaults (a required param takes its Tinybird default, else a sample), then a sample value for every param. */
function paramSets(params: EndpointParam[]): Array<Record<string, string>> {
  const defaults = Object.fromEntries(
    params.filter((param) => param.required).map((param) => [param.name, param.default !== undefined ? String(param.default) : (PARAM_KINDS[param.type]?.sample ?? '')])
  )
  const samples = Object.fromEntries(params.map((param) => [param.name, PARAM_KINDS[param.type]?.sample ?? '']))
  const sets = [defaults]
  if (params.length > 0) sets.push(samples)
  return sets
}

function identifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, '_')
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}
