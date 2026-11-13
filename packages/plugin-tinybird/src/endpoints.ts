import { tokenizeSQL } from '@chkit/core'

import type { Datafile, DatafileNode } from './datafile.js'
import type { PipeScope } from './pipes.js'
import { PYTHON_FLOAT_SOURCE, pythonFloat } from './python-float.js'
import { oneLine, type Translation } from './report.js'
import { resolveNode, SqlResolveError, tableReferences } from './sql-resolve.js'

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
 * A param without a default is required: Tinybird answers "Required parameter
 * is not defined" when it is missing (`required=` is not read at runtime).
 * Anything else (control flow, `defined()`, `column()`, `Array()`, `Boolean()`,
 * ...) is reported, per endpoint, as not translated.
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

/**
 * Tinybird's own validators (`tinybird/datatypes.py`: `date_pattern`,
 * `datetime_patterns`, `datetime64_patterns`), matched from the start as
 * Python's re.match does: a DateTime accepts anything after the seconds. Every
 * accepted value renders as the same String literal, which the String binding
 * reproduces.
 */
const PATTERNS = {
  DATE: String.raw`^\d\d\d\d-\d\d-\d\d$`,
  DATE_TIME: String.raw`^(?:\d\d\d\d.\d\d.\d\d(?:T|\s)\d\d:\d\d:\d\d|\d\d.\d\d.\d\d\d\d.\d{1,2}:\d{1,2}:\d{1,2})`,
  DATE_TIME64: String.raw`^(?:\d\d\d\d.\d\d.\d\d(?:T|\s)\d\d:\d\d:\d\d.\d\d\d|\d\d.\d\d.\d\d\d\d.\d{1,2}:\d{1,2}:\d{1,2}.\d{1,3})`,
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

// The opening of a template interpolation, written as data so no escape is needed.
const INTERPOLATION_OPEN = ['$', '{'].join('')
const TEMPLATE_TAG = /\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}|\{#([\s\S]*?)#\}/g
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*):String\}/g

export function translateEndpoint(file: Datafile, output: DatafileNode | undefined, scope: PipeScope): Translation<TranslatedEndpoint> {
  if (!output) return { ok: false, reasons: ['the endpoint has no nodes'] }
  const params = new Map<string, EndpointParam>()
  const reasons: string[] = []
  const nodes = new Map<string, string>()
  // Tinybird renders only the nodes the output node reads, directly or through other nodes.
  const reached = reachableNodes(file.nodes, output.name)
  for (const node of file.nodes.filter((candidate) => reached.has(candidate.name))) {
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
      source: renderEndpoint({ pipe: file.name, exportName, sql, params: used }, new Set([...UNAVAILABLE_NAMES, exportName])),
      paramSets: paramSets(used),
    },
    notes: used.length > 0 ? [`params: ${used.map((param) => `${param.name} (${param.type}${param.required ? ', required' : ''})`).join(', ')}`] : [],
  }
}

export function renderQueriesFile(endpoints: TranslatedEndpoint[], database: string): string {
  const patterns = Object.keys(PATTERNS).filter((key) => endpoints.some((endpoint) => endpoint.source.includes(`.regex(${key})`))) as Array<keyof typeof PATTERNS>
  // Hoisted param consts get names no export and no module name uses.
  const taken = new Set([...UNAVAILABLE_NAMES, ...endpoints.map((endpoint) => endpoint.exportName)])
  const lines = [
    `import { p, query, t } from '@chkit/core'`,
    '',
    `// Imported from Tinybird endpoints by chkit plugin tinybird import, reading database ${oneLine(database)}.`,
    '// Every param binds as a ClickHouse String inside the function Tinybird wraps it in, e.g.',
    "// toInt32({limit:String}), so ClickHouse runs the SQL Tinybird runs; p still validates its type.",
    '// Floats are sent as Python formats them (1 → 1.0), as Tinybird renders them.',
    '',
    ...patterns.map((key) => `const ${key} = /${PATTERNS[key]}/`),
    ...(patterns.length > 0 ? [''] : []),
    ...(endpoints.some((endpoint) => endpoint.params.some((param) => isFloat(param.type))) ? [PYTHON_FLOAT_SOURCE, ''] : []),
    endpoints.map((endpoint) => renderEndpoint(endpoint, taken)).join('\n\n'),
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
    // Tinybird renders a missing param with each site's own default; required= is never read.
    const seen = params.get(param.value.name)
    if (seen && (seen.type !== param.value.type || seen.default !== param.value.default)) {
      reasons.push(`param ${param.value.name} is declared twice with different types or defaults`)
      return tag
    }
    if (seen) seen.required ||= param.value.required
    else params.set(param.value.name, param.value)
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
      if (literal === undefined) return { ok: false, reasons: [`the default of ${nameArg.value} is not a plain literal (Python string escapes and adjacent literals are not translated)`] }
      // A number given to a String-like param renders as Python's str() of it: String(x, 1.50) → '1.5'.
      const numberLiteral = !/^['"]/.test(arg.value)
      if (numberLiteral && !PARAM_KINDS[type]?.cast) {
        // Python 3 rejects an integer with a leading zero (a float may have one).
        if (!literal.includes('.') && /^-?0\d/.test(literal)) {
          return { ok: false, reasons: [`the default ${literal} of ${nameArg.value} is not a Python number literal`] }
        }
        defaultValue = literal.includes('.') ? pythonFloat(Number(literal)) : BigInt(literal).toString()
      } else defaultValue = literal
    } else if (key === 'required') {
      // Metadata only: Tinybird accepts any value and does not read it at runtime.
      required = /^(['"]?)(True|true)\1$/.test(arg.value)
    } else if (key !== 'description' && key !== 'example') {
      return { ok: false, reasons: [`argument ${key ?? arg.value} of ${type}(${nameArg.value}) is not translated`] }
    }
  }
  const kind = PARAM_KINDS[type]
  if (typeof defaultValue === 'string' && kind?.cast && !/^-?\d+(?:\.\d+)?$/.test(defaultValue)) {
    return { ok: false, reasons: [`the default '${defaultValue}' of ${nameArg.value} is not a number`] }
  }
  if (defaultValue !== undefined && kind?.cast && !isFloat(type) && !/^-?\d+$/.test(String(defaultValue))) {
    return { ok: false, reasons: [`the default ${defaultValue} of ${nameArg.value} is not an integer`] }
  }
  return { ok: true, value: { name: nameArg.value, type, required, ...(defaultValue !== undefined ? { default: normalizeDefault(defaultValue, kind) } : {}) }, notes: [] }
}

/**
 * Numbers as numbers, except an integer beyond 2^53, which keeps its digits as
 * a string (rendered as a BigInt literal). Strings as strings.
 */
function normalizeDefault(value: string | number, kind: ParamKind | undefined): string | number {
  if (!kind?.cast) return String(value)
  const number = Number(value)
  if (kind.schema.startsWith('t.float')) return number
  return Number.isSafeInteger(number) ? number : String(value)
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
function pythonLiteral(text: string): string | undefined {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text)
  // Escapes and adjacent literals ('it''s') follow Python rules the importer does not reproduce.
  if (quoted) return /[\\'"]/.test(quoted[2] ?? '') ? undefined : (quoted[2] ?? '')
  // Kept as text, so a 64-bit integer keeps every digit.
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text
  return undefined
}

/**
 * The query source of an endpoint. A param used more than once is hoisted to
 * one const and interpolated at every site: chkit merges two separate `p()`
 * schemas of the same name by intersecting them, which drops their default.
 * Const names are taken from `taken` and added to it.
 */
function renderEndpoint(
  endpoint: Pick<TranslatedEndpoint, 'pipe' | 'exportName' | 'sql' | 'params'>,
  taken: Set<string>
): string {
  const params = new Map(endpoint.params.map((param) => [param.name, param]))
  const uses = new Map<string, number>()
  for (const [, name] of endpoint.sql.matchAll(PLACEHOLDER)) if (name) uses.set(name, (uses.get(name) ?? 0) + 1)
  const hoisted = new Map<string, string>()
  for (const param of endpoint.params) {
    if ((uses.get(param.name) ?? 0) < 2) continue
    let name = `${endpoint.exportName}_${param.name}`
    for (let n = 2; taken.has(name); n++) name = `${endpoint.exportName}_${param.name}_${n}`
    taken.add(name)
    hoisted.set(param.name, name)
  }
  const body = escapeTemplate(endpoint.sql).replace(PLACEHOLDER, (placeholder, name: string) => {
    const param = params.get(name)
    if (!param) return placeholder
    return interpolation(hoisted.get(name) ?? paramSource(param))
  })
  const consts = [...hoisted].map(([name, constName]) => {
    const param = params.get(name)
    return param ? `const ${constName} = ${paramSource(param)}\n` : ''
  })
  return `${consts.join('')}export const ${endpoint.exportName} = query({ name: ${JSON.stringify(endpoint.pipe)} })\`\n${body}\n\``
}

function paramSource(param: EndpointParam): string {
  const kind = PARAM_KINDS[param.type]
  if (!kind) throw new Error(`no param kind for ${param.type}`)
  const float = isFloat(param.type)
  // A float is sent as Python formats it; prefault runs the default through that transform too.
  const schema = `${kind.schema}${kind.pattern ? `.regex(${kind.pattern})` : ''}${kind.cast ? `.meta({ clickhouse: 'String' })` : ''}${float ? '.transform(pythonFloat)' : ''}`
  const value = `p(${JSON.stringify(param.name)}, ${schema})`
  // Tinybird uses the default whenever the param is missing, also with required=True.
  if (param.default === undefined) return value
  const literal = typeof param.default === 'string' && kind.cast ? `${param.default}n` : JSON.stringify(param.default)
  return `${value}.${float ? 'prefault' : 'default'}(${literal})`
}

function isFloat(type: string): boolean {
  return type === 'Float32' || type === 'Float64'
}

/** `${expression}` in the generated template literal. */
function interpolation(expression: string): string {
  return [INTERPOLATION_OPEN, expression, '}'].join('')
}

/** Text for a JavaScript template literal: backslashes, backticks and `${` are escaped. */
function escapeTemplate(sql: string): string {
  return sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/** Every param left out (a param without a default takes a sample), then a sample value for every param. */
function paramSets(params: EndpointParam[]): Array<Record<string, string>> {
  const defaults = Object.fromEntries(
    params.filter((param) => param.default === undefined).map((param) => [param.name, PARAM_KINDS[param.type]?.sample ?? ''])
  )
  const samples = Object.fromEntries(params.map((param) => [param.name, PARAM_KINDS[param.type]?.sample ?? '']))
  const sets = [defaults]
  if (params.length > 0) sets.push(samples)
  return sets
}

/** JavaScript reserved words, and the names the generated module declares itself. */
const UNAVAILABLE_NAMES = new Set([
  'arguments', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'eval', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import',
  'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return',
  'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with',
  'yield', 'NaN', 'Infinity', 'p', 'query', 't', 'pythonFloat', ...Object.keys(PATTERNS),
])

/** The export name for a pipe: a JavaScript identifier that is not reserved and not one the module declares. */
export function identifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, '_')
  const valid = /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
  return UNAVAILABLE_NAMES.has(valid) ? `${valid}_endpoint` : valid
}

/**
 * The output node and every node it reads, directly or through other nodes.
 * References are found in the raw node SQL, so a table read in only one
 * branch of a template condition still counts (it may be rendered).
 */
function reachableNodes(nodes: readonly DatafileNode[], output: string): Set<string> {
  const byName = new Map(nodes.map((node) => [node.name, node.sql ?? '']))
  const names = new Set(byName.keys())
  const reached = new Set<string>()
  const queue = [output]
  while (queue.length > 0) {
    const name = queue.pop() ?? ''
    if (reached.has(name) || !byName.has(name)) continue
    reached.add(name)
    for (const ref of tableReferences(tokenizeSQL(byName.get(name) ?? ''), names)) {
      // A CTE of the same name shadows the node, as in the resolver.
      if (ref.database === undefined && !ref.cte && names.has(ref.name)) queue.push(ref.name)
    }
  }
  return reached
}
