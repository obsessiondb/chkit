/** The outcome of translating one Tinybird object. */
export type Translation<T> = { ok: true; value: T; notes: string[] } | { ok: false; reasons: string[] }

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

/** Comment lines for the generated schema file: what was not translated, and why. */
export function untranslatableSummary(report: ImportReport): string[] {
  const entries = report.entries.filter((entry) => entry.status === 'untranslatable')
  if (entries.length === 0) return []
  return [
    'Not translated (see the import report for details):',
    ...entries.flatMap((entry) =>
      entry.status === 'untranslatable' ? [`  ${entry.kind} ${oneLine(entry.name)}: ${oneLine(entry.reasons.join('; '))}`] : []
    ),
  ]
}

/** Datafile text quoted in a reason may span lines; a comment line must not. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
}
