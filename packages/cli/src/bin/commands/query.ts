import type { CommandDef, CommandRunContext } from '../../plugins.js'
import { emitJson } from '../json-output.js'

export const queryCommand: CommandDef = {
  name: 'query',
  description: 'Run a SQL query against the configured target',
  flags: [],
  run: cmdQuery,
}

async function cmdQuery(runCtx: CommandRunContext): Promise<void> {
  const { flags, positionals, ctx } = runCtx
  const jsonMode = flags['--json'] === true

  const sql = positionals[0]
  if (!sql || sql.trim().length === 0) {
    throw new Error('query requires a SQL string as the first positional argument (e.g. `chkit query "SELECT 1"`)')
  }
  if (positionals.length > 1) {
    throw new Error('query accepts a single SQL string. Wrap it in quotes if it contains spaces.')
  }

  if (!ctx.hasExecutor) {
    throw new Error('No target configured. Provide clickhouse settings in your config or install a plugin (e.g. obsessiondb) that supplies one.')
  }

  const rows = await ctx.executor.query<Record<string, unknown>>(sql)

  if (jsonMode) {
    emitJson('query', { rowCount: rows.length, rows })
    return
  }

  printRows(rows)
}

function printRows(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('(no rows)')
    return
  }

  const columns = Array.from(
    rows.reduce<Set<string>>((acc, row) => {
      for (const key of Object.keys(row)) acc.add(key)
      return acc
    }, new Set<string>())
  )

  const stringified = rows.map((row) =>
    columns.map((col) => stringifyCell(row[col]))
  )

  const widths = columns.map((col, idx) => {
    let width = col.length
    for (const r of stringified) {
      const cell = r[idx] ?? ''
      if (cell.length > width) width = cell.length
    }
    return width
  })

  const header = columns.map((col, idx) => col.padEnd(widths[idx]!)).join(' │ ')
  const separator = widths.map((w) => '─'.repeat(w)).join('─┼─')
  console.log(header)
  console.log(separator)
  for (const r of stringified) {
    console.log(r.map((cell, idx) => cell.padEnd(widths[idx]!)).join(' │ '))
  }
  console.log(`\n(${rows.length} row${rows.length === 1 ? '' : 's'})`)
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value)
}
