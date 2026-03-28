import type { SortKeyInfo } from './types.js'

export function splitNumericRange(min: number, max: number, count: number): Array<{ from: string; to: string }> {
  const span = max - min
  const step = span / count
  const ranges: Array<{ from: string; to: string }> = []
  for (let i = 0; i < count; i++) {
    const from = min + i * step
    const to = i === count - 1 ? max + 1 : min + (i + 1) * step
    ranges.push({ from: String(from), to: String(to) })
  }
  return ranges
}

export function splitDateTimeRange(min: string, max: string, count: number): Array<{ from: string; to: string }> {
  const minMs = new Date(min).getTime()
  const maxMs = new Date(max).getTime()
  const span = maxMs - minMs
  const step = span / count
  const ranges: Array<{ from: string; to: string }> = []
  for (let i = 0; i < count; i++) {
    const from = new Date(minMs + i * step).toISOString()
    const to = i === count - 1
      ? new Date(maxMs + 1).toISOString()
      : new Date(minMs + (i + 1) * step).toISOString()
    ranges.push({ from, to })
  }
  return ranges
}

export function stringToUint64(s: string): bigint {
  let result = 0n
  const bytes = Math.min(s.length, 8)
  for (let i = 0; i < bytes; i++) {
    result = (result << 8n) | BigInt(s.charCodeAt(i))
  }
  // Pad remaining bytes with zeros
  for (let i = bytes; i < 8; i++) {
    result = result << 8n
  }
  return result
}

export function uint64ToString(n: bigint): string {
  const chars: string[] = []
  for (let i = 7; i >= 0; i--) {
    const byte = Number((n >> BigInt(i * 8)) & 0xffn)
    chars.push(String.fromCharCode(byte))
  }
  // Trim trailing NUL bytes (padding from stringToUint64 for short strings)
  let end = chars.length
  while (end > 0 && chars[end - 1] === '\0') end--
  return chars.slice(0, end).join('')
}

export function splitStringRange(min: string, max: string, count: number): Array<{ from: string; to: string }> {
  const minVal = stringToUint64(min)
  const maxVal = stringToUint64(max)
  const span = maxVal - minVal
  const step = span / BigInt(count)
  const ranges: Array<{ from: string; to: string }> = []
  for (let i = 0; i < count; i++) {
    const from = uint64ToString(minVal + BigInt(i) * step)
    const to = i === count - 1
      ? uint64ToString(maxVal + 1n)
      : uint64ToString(minVal + BigInt(i + 1) * step)
    ranges.push({ from, to })
  }
  return ranges
}

export function splitSortKeyRange(
  category: SortKeyInfo['category'],
  min: string,
  max: string,
  count: number,
): Array<{ from: string; to: string }> {
  switch (category) {
    case 'numeric':
      return splitNumericRange(Number(min), Number(max), count)
    case 'datetime':
      return splitDateTimeRange(min, max, count)
    case 'string':
      return splitStringRange(min, max, count)
  }
}
