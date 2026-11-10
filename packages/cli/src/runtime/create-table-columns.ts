/**
 * The names a `CREATE TABLE` statement defines in its column list, as
 * ClickHouse renders it in `system.tables.create_table_query`: each column,
 * plus the name after INDEX, PROJECTION, CONSTRAINT or STATISTICS. A name may
 * be quoted with backticks or double quotes, or bare, depending on
 * `show_create_query_identifier_quoting_style` and `_rule`; text in string
 * literals and comments is never a name. Returns undefined when the statement
 * cannot be read this way, so a caller never takes it for a missing column.
 * Same as the Python `create_table_element_names`.
 */
export function createTableElementNames(createQuery: string): string[] | undefined {
  const elements = columnListElements(createQuery)
  if (!elements) return undefined
  const names: string[] = []
  for (const element of elements) {
    const first = readIdentifier(element, skipBlank(element, 0))
    if (!first) return undefined
    names.push(first.name)
    if (!first.quoted && NAMED_ELEMENT_KEYWORDS.has(first.name.toUpperCase())) {
      const second = readIdentifier(element, skipBlank(element, first.end))
      if (!second) return undefined
      names.push(second.name)
    }
  }
  return names
}

const NAMED_ELEMENT_KEYWORDS = new Set(['INDEX', 'PROJECTION', 'CONSTRAINT', 'STATISTICS'])

/** The text of each top-level element between the first `(` and its `)`. */
function columnListElements(sql: string): string[] | undefined {
  let index = 0
  let depth = 0
  let start = -1
  const elements: string[] = []
  while (index < sql.length) {
    const char = sql[index] ?? ''
    if (char === "'" || char === '`' || char === '"') {
      const end = skipQuoted(sql, index)
      if (end === undefined) return undefined
      index = end
      continue
    }
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (sql.startsWith('/*', index)) {
      const close = sql.indexOf('*/', index + 2)
      if (close === -1) return undefined
      index = close + 2
      continue
    }
    if (char === '(' || char === '[') {
      depth += 1
      if (depth === 1 && char === '(') start = index + 1
    } else if (char === ')' || char === ']') {
      depth -= 1
      if (depth < 0) return undefined
      if (depth === 0 && start !== -1) {
        elements.push(sql.slice(start, index))
        return elements
      }
    } else if (char === ',' && depth === 1 && start !== -1) {
      elements.push(sql.slice(start, index))
      start = index + 1
    }
    index += 1
  }
  return undefined
}

/** The index after the quoted text that starts at `start`; undefined when it never closes. */
function skipQuoted(sql: string, start: number): number | undefined {
  const quote = sql[start]
  let index = start + 1
  while (index < sql.length) {
    const char = sql[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) {
      if (sql[index + 1] === quote) {
        index += 2
        continue
      }
      return index + 1
    }
    index += 1
  }
  return undefined
}

function skipBlank(text: string, start: number): number {
  let index = start
  while (index < text.length) {
    if (/\s/.test(text[index] ?? '')) {
      index += 1
    } else if (text.startsWith('--', index)) {
      const newline = text.indexOf('\n', index)
      index = newline === -1 ? text.length : newline + 1
    } else if (text.startsWith('/*', index)) {
      const close = text.indexOf('*/', index + 2)
      index = close === -1 ? text.length : close + 2
    } else {
      break
    }
  }
  return index
}

function readIdentifier(text: string, start: number): { name: string; quoted: boolean; end: number } | undefined {
  const quote = text[start]
  if (quote === '`' || quote === '"') {
    let name = ''
    let index = start + 1
    while (index < text.length) {
      const char = text[index] ?? ''
      if (char === '\\') {
        name += text[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) {
        if (text[index + 1] === quote) {
          name += quote
          index += 2
          continue
        }
        return { name, quoted: true, end: index + 1 }
      }
      name += char
      index += 1
    }
    return undefined
  }
  const bare = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(start))
  return bare ? { name: bare[0], quoted: false, end: start + bare[0].length } : undefined
}
