export function compareBinaryStrings(left: string, right: string): number {
  return Buffer.from(left, 'latin1').compare(Buffer.from(right, 'latin1'))
}

export function minBinaryString(left: string, right: string): string {
  return compareBinaryStrings(left, right) <= 0 ? left : right
}

export function maxBinaryString(left: string, right: string): string {
  return compareBinaryStrings(left, right) >= 0 ? left : right
}

export function nextPrefixValue(prefix: string): string | undefined {
  if (prefix.length === 0) return undefined

  const buffer = Buffer.from(prefix, 'latin1')
  for (let index = buffer.length - 1; index >= 0; index--) {
    const byte = buffer[index]
    if (byte === undefined || byte === 0xff) continue

    const next = Buffer.from(buffer.subarray(0, index + 1))
    next[index] = byte + 1
    return next.toString('latin1')
  }

  return undefined
}

export function buildObservedStringUpperBound(maxValue: string): string {
  return `${maxValue}\0`
}

export function strToBigInt(value: string, padTo: number): bigint {
  const buffer = Buffer.from(value, 'latin1')
  let result = 0n

  for (let index = 0; index < padTo; index++) {
    const byte = index < buffer.length ? (buffer[index] ?? 0) : 0
    result = (result << 8n) | BigInt(byte)
  }

  return result
}

export function bigIntToStr(value: bigint, length: number): string {
  const buffer = Buffer.alloc(length)
  let remaining = value

  for (let index = length - 1; index >= 0; index--) {
    buffer[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }

  return buffer.toString('latin1')
}
