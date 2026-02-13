export function splitTopLevelComma(input: string): string[] {
  const out: string[] = []
  let current = ''
  let depth = 0
  let quote: "'" | '"' | '`' | null = null

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? ''
    const prev = i > 0 ? input[i - 1] : ''

    if (quote) {
      current += char
      if (char === quote && prev !== '\\') quote = null
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      continue
    }

    if (char === '(') {
      depth += 1
      current += char
      continue
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }

    if (char === ',' && depth === 0) {
      const token = current.trim()
      if (token.length > 0) out.push(token)
      current = ''
      continue
    }

    current += char
  }

  const tail = current.trim()
  if (tail.length > 0) out.push(tail)

  return out
}

export function normalizeKeyColumns(values: string[]): string[] {
  return values.flatMap((value) => splitTopLevelComma(value.trim()))
}
