/**
 * Parser for Tinybird datafiles (`.datasource`, `.pipe`), following the line
 * grammar of the Tinybird CLI (`tinybird/datafile/common.py`): a command is the
 * first shell token of a line; `CMD >` opens a block that runs until a line
 * starting at column 0 whose first token is another command of the file kind;
 * blank and comment-only lines inside a block are dropped, as Tinybird does.
 * `NODE` starts a node, and node commands attach to the current node.
 */

export type DatafileKind = 'datasource' | 'pipe'

export interface DatafileNode {
  name: string
  line: number
  sql?: string
  description?: string
  /** Single-line node commands by upper-case name: TYPE, DATASOURCE, COPY_SCHEDULE, ... */
  vars: Map<string, string>
}

export interface Datafile {
  path: string
  kind: DatafileKind
  /** Resource name: the file name without its extension. */
  name: string
  description?: string
  /** File-level single-line commands by upper-case name (ENGINE, ENGINE_TTL, ...). */
  vars: Map<string, string>
  /** File-level blocks by upper-case name (SCHEMA, INDEXES, FORWARD_QUERY). */
  blocks: Map<string, string>
  nodes: DatafileNode[]
  /** Commands the importer does not evaluate (INCLUDE, VERSION), with their line. */
  unsupported: Array<{ command: string; line: number }>
}

export class DatafileSyntaxError extends Error {
  constructor(path: string, line: number, message: string) {
    super(`${path}:${line}: ${message}`)
    this.name = 'DatafileSyntaxError'
  }
}

const DATASOURCE_COMMANDS = new Set([
  'description', 'token', 'source', 'schema', 'indexes', 'engine', 'partition_key', 'sorting_key', 'primary_key',
  'sampling_key', 'ttl', 'tags', 'include', 'version', 'kafka_connection_name', 'kafka_topic', 'kafka_group_id',
  'kafka_auto_offset_reset', 'kafka_store_raw_value', 'kafka_store_headers', 'kafka_store_binary_headers',
  'kafka_key_format', 'kafka_value_format', 'kafka_target_partitions', 'import_connection_name', 'import_schedule',
  'import_strategy', 'import_bucket_uri', 'import_format', 'import_from_timestamp', 'import_service',
  'import_external_datasource', 'import_query', 'import_table_arn', 'import_export_bucket', 'pg_connection_name',
  'pg_table', 'shared_with', 'export_service', 'forward_query', 'backfill',
  // ENGINE_* parameters and options (tinybird/ch_utils/engine.py VALID_ENGINE_PARAMS)
  'engine_ver', 'engine_is_deleted', 'engine_columns', 'engine_sign', 'engine_version', 'engine_partition_key',
  'engine_sorting_key', 'engine_primary_key', 'engine_sampling_key', 'engine_ttl', 'engine_settings',
])

const PIPE_COMMANDS = new Set([
  'node', 'scope', 'description', 'type', 'datasource', 'tags', 'target_datasource', 'copy_schedule', 'copy_mode',
  'mode', 'on_demand_compute', 'filter', 'token', 'include', 'sql', 'version', 'deployment_method', 'export_service',
  'export_connection_name', 'export_schedule', 'export_bucket_uri', 'export_file_template', 'export_format',
  'export_strategy', 'export_compression', 'export_write_strategy', 'export_kafka_topic',
])

/** Pipe commands that Tinybird stores on the current node rather than on the file. */
const PIPE_NODE_COMMANDS = new Set([
  'type', 'datasource', 'target_datasource', 'copy_schedule', 'copy_mode', 'mode', 'on_demand_compute', 'filter',
])

// VERSION is a deprecated no-op in the Forward CLI; INCLUDE splices other datafiles in.
const UNSUPPORTED_COMMANDS = new Set(['include'])

export function parseDatafile(path: string, text: string): Datafile {
  const kind: DatafileKind = path.endsWith('.datasource') ? 'datasource' : 'pipe'
  const commands = kind === 'datasource' ? DATASOURCE_COMMANDS : PIPE_COMMANDS
  const file: Datafile = {
    path,
    kind,
    name: resourceName(path),
    vars: new Map(),
    blocks: new Map(),
    nodes: [],
    unsupported: [],
  }
  let current: DatafileNode | undefined
  let block: { command: string; line: number; text: string } | undefined

  const closeBlock = () => {
    if (!block) return
    applyBlock(file, current, block, path)
    block = undefined
  }

  const lines = splitLines(text)
  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const tokens = shellTokens(line)
    if (tokens.length === 0) return
    const [first = '', ...args] = tokens
    const command = first.toLowerCase()
    if (block && commands.has(command) && !/^[ \t]/.test(line)) closeBlock()
    if (block) {
      block.text += line
      return
    }
    if (args[0] === '>') {
      block = { command, line: lineNumber, text: '' }
      return
    }
    if (command === 'settings') {
      throw new DatafileSyntaxError(path, lineNumber, 'SETTINGS is not allowed, use ENGINE_SETTINGS')
    }
    if (!commands.has(command)) {
      throw new DatafileSyntaxError(path, lineNumber, `${first.toUpperCase()} is not a valid option in ${kind} files`)
    }
    if (UNSUPPORTED_COMMANDS.has(command)) file.unsupported.push({ command: command.toUpperCase(), line: lineNumber })
    const value = unquote(args.join(' ').trim())
    if (command === 'node' || command === 'scope') {
      current = { name: unquote(args[0] ?? ''), line: lineNumber, vars: new Map() }
      file.nodes.push(current)
      return
    }
    if (command === 'token') return
    if (command === 'description') {
      setDescription(file, current, args.join(' ').trim())
      return
    }
    if (kind === 'pipe' && PIPE_NODE_COMMANDS.has(command)) {
      if (!current) throw new DatafileSyntaxError(path, lineNumber, `${command.toUpperCase()} must come after a NODE`)
      current.vars.set(command.toUpperCase(), value)
      return
    }
    file.vars.set(command.toUpperCase(), value)
  })
  closeBlock()
  return file
}

function applyBlock(
  file: Datafile,
  node: DatafileNode | undefined,
  block: { command: string; line: number; text: string },
  path: string
): void {
  switch (block.command) {
    case 'sql': {
      if (!node) throw new DatafileSyntaxError(path, block.line, 'SQL must come after a NODE')
      const trimmed = block.text.trim()
      node.sql = trimmed.startsWith('%') ? trimmed : dedent(block.text).trimEnd()
      return
    }
    case 'description':
      setDescription(file, node, block.text.trim())
      return
    default:
      file.blocks.set(block.command.toUpperCase(), unquote(block.text))
  }
}

function setDescription(file: Datafile, node: DatafileNode | undefined, description: string): void {
  if (node) node.description = description
  else file.description = description
}

function resourceName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.(datasource|pipe)$/, '')
}

/** Lines with their line terminator, as Python's `StringIO(..., newline=None)` yields them. */
function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/**
 * Tokens as Python's non-POSIX `shlex.shlex(line)` with `whitespace_split`
 * yields them: quoted strings keep their quotes and end at the closing quote,
 * `#` outside quotes starts a comment. A line shlex cannot tokenize (an
 * unclosed quote) is one token, as Tinybird's fallback makes it.
 */
export function shellTokens(line: string): string[] {
  const tokens: string[] = []
  let token = ''
  let state: ' ' | 'a' | '"' | "'" = ' '
  for (const char of line) {
    if (state === '"' || state === "'") {
      token += char
      if (char === state) {
        tokens.push(token)
        token = ''
        state = ' '
      }
      continue
    }
    if (/\s/.test(char)) {
      if (state === 'a') {
        tokens.push(token)
        token = ''
        state = ' '
      }
      continue
    }
    if (char === '#') break
    if (state === ' ' && (char === '"' || char === "'")) {
      token = char
      state = char
      continue
    }
    token += char
    state = 'a'
  }
  if (state === '"' || state === "'") return [line.trim()]
  if (state === 'a') tokens.push(token)
  return tokens
}

/** Tinybird's `_unquote`: drops one pair of surrounding quotes. */
export function unquote(value: string): string {
  if (value.length >= 2 && `"'`.includes(value[0] ?? '') && `"'`.includes(value[value.length - 1] ?? '')) {
    return value.slice(1, -1)
  }
  return value
}

/** Python's `textwrap.dedent`: removes the longest common leading whitespace of non-blank lines. */
function dedent(text: string): string {
  const lines = text.split('\n')
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => /^[ \t]*/.exec(line)?.[0] ?? '')
  const common = indents.reduce<string | undefined>((prefix, indent) => {
    if (prefix === undefined) return indent
    let length = 0
    while (length < prefix.length && length < indent.length && prefix[length] === indent[length]) length++
    return prefix.slice(0, length)
  }, undefined) ?? ''
  return lines.map((line) => (line.trim().length === 0 ? line.trim() : line.slice(common.length))).join('\n')
}
