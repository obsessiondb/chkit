import { parseJsonEachRowLine } from '@chkit/core'

import { parseJsonResult } from './exact-json.js'

/** ClickHouse FORMAT JSON writes meta before data, then its row count. */
export async function* parseJsonBatches<T>(stream: AsyncIterable<Uint8Array>, options: { allowEmpty?: boolean } = {}): AsyncGenerator<T[]> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let prefix = ''
  let pending = ''
  let suffix = ''
  let phase: 'prefix' | 'data' | 'suffix' = 'prefix'
  let quoted = false
  let escaped = false
  let depth = 0
  let count = 0
  let needsRow = false
  let row = ''
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true })
    if (phase === 'prefix') {
      // The match starts after the complete metadata array, never in a column name.
      const match = /\]\s*,\s*"data"\s*:\s*\[/.exec(pending)
      if (!match) continue
      const end = match.index + match[0].length
      prefix = pending.slice(0, end)
      parseJsonResult(`${prefix}],"rows":0}`)
      pending = pending.slice(end)
      phase = 'data'
    }
    const batch: T[] = []
    for (const char of pending) {
      if (phase === 'suffix') { suffix += char; continue }
      if (depth === 0) {
        if (/[ \t\r\n]/.test(char)) continue
        if (char === ']' && !needsRow) { phase = 'suffix'; continue }
        if (char === ',' && count > 0 && !needsRow) { needsRow = true; continue }
        if (char !== '{' || (count > 0 && !needsRow)) throw new Error('Invalid ClickHouse JSON data')
        row = '{'
        depth = 1
        needsRow = false
        continue
      }
      row += char
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{' || char === '[') depth++
      else if (char === '}' || char === ']') {
        depth--
        if (depth === 0) {
          batch.push(parseJsonEachRowLine<T>(row))
          count++
          row = ''
        }
      }
    }
    pending = ''
    if (batch.length) yield batch
  }
  const tail = decoder.decode()
  if (phase === 'prefix' && options.allowEmpty && (pending + tail).trim() === '') return
  if (phase !== 'suffix' || tail) throw new Error('Incomplete ClickHouse JSON result envelope')
  parseJsonResult(`${prefix}]${suffix}`, { expectedRows: count })
}
