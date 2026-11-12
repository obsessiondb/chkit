/** The outcome of translating one Tinybird object. */
/** `warnings`: what the user must act on although the object translated (e.g. ingestion to set up). */
export type Translation<T> = { ok: true; value: T; notes: string[]; warnings?: string[] } | { ok: false; reasons: string[] }

/** `pipe`: a pipe whose kind is unknown because it INCLUDEs datafile text the importer does not evaluate. */
export type ObjectKind = 'datasource' | 'materialized' | 'copy' | 'endpoint' | 'pipe'

export type ImportEntry =
  | {
      kind: ObjectKind
      name: string
      file: string
      status: 'translated'
      /** The chkit object it became. */
      chkit: { kind: 'table' | 'materialized_view' | 'query'; database?: string; name: string }
      notes: string[]
      warnings?: string[]
    }
  | { kind: ObjectKind; name: string; file: string; status: 'untranslatable'; reasons: string[] }
  | { kind: 'other'; name: string; file: string; status: 'skipped'; reasons: string[] }

export interface ImportReport {
  project: string
  database: string
  entries: ImportEntry[]
}

export type ImportCounts = Record<ObjectKind, { translated: number; untranslatable: number }> & { skipped: number }

export function countEntries(report: ImportReport): ImportCounts {
  const counts: ImportCounts = {
    datasource: { translated: 0, untranslatable: 0 },
    materialized: { translated: 0, untranslatable: 0 },
    copy: { translated: 0, untranslatable: 0 },
    endpoint: { translated: 0, untranslatable: 0 },
    pipe: { translated: 0, untranslatable: 0 },
    skipped: 0,
  }
  for (const entry of report.entries) {
    if (entry.kind === 'other') counts.skipped++
    else counts[entry.kind][entry.status === 'translated' ? 'translated' : 'untranslatable']++
  }
  return counts
}

/**
 * What was not translated, and what translated with something to set up: one
 * line per object, then each reason on its own indented line, wrapped. Used for
 * the schema file header (as `//` comments) and the command's text output. The
 * JSON report keeps every reason as it is.
 */
export function untranslatableSummary(report: ImportReport): string[] {
  const untranslatable = report.entries.flatMap((entry) => (entry.status === 'untranslatable' ? [entryLines(entry.kind, entry.name, entry.reasons)] : []))
  const warned = report.entries.flatMap((entry) =>
    entry.status === 'translated' && entry.warnings?.length ? [entryLines(entry.kind, entry.name, entry.warnings)] : []
  )
  return [
    ...(untranslatable.length > 0 ? ['Not translated (see the import report for details):', ...untranslatable.flat()] : []),
    ...(warned.length > 0 ? ['Translated, with something to set up:', ...warned.flat()] : []),
  ]
}

const WIDTH = 110
const CONTROL_FLOW = /^(node \S+: )control flow (\{%[\s\S]*?%\}) has no static chkit query equivalent$/

function entryLines(kind: string, name: string, reasons: readonly string[]): string[] {
  return [`  ${kind} ${oneLine(name)}:`, ...summarizeReasons(reasons).flatMap((reason) => wrap(oneLine(reason), '    - ', '      '))]
}

/**
 * Identical reasons once; the control-flow statements of one node as one
 * reason that lists every statement, in order.
 */
export function summarizeReasons(reasons: readonly string[]): string[] {
  const out: string[] = []
  const statements = new Map<string, string[]>()
  for (const reason of new Set(reasons)) {
    const match = CONTROL_FLOW.exec(reason)
    if (!match) {
      out.push(reason)
      continue
    }
    const [, node = '', statement = ''] = match
    const seen = statements.get(node)
    if (seen) {
      seen.push(statement)
      continue
    }
    statements.set(node, [statement])
    out.push(node)
  }
  return out.map((reason) => {
    const list = statements.get(reason)
    if (!list) return reason
    return list.length === 1
      ? `${reason}control flow ${list[0]} has no static chkit query equivalent`
      : `${reason}${list.length} control-flow statements have no static chkit query equivalent: ${list.join(', ')}`
  })
}

/** Words to lines of at most WIDTH characters; a longer word gets a line of its own. */
function wrap(text: string, first: string, rest: string): string[] {
  const lines: string[] = []
  let line = first
  for (const word of text.split(' ')) {
    const prefix = lines.length === 0 ? first : rest
    if (line.length > prefix.length && line.length + 1 + word.length > WIDTH) {
      lines.push(line)
      line = rest + word
    } else {
      line = line.length > prefix.length ? `${line} ${word}` : `${line}${word}`
    }
  }
  lines.push(line)
  return lines
}

/** Datafile text quoted in a reason may span lines; a comment line must not. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
}
