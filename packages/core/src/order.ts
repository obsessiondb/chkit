/**
 * Compare two strings by Unicode code point, matching Python's default
 * `str` ordering. `String.prototype.localeCompare` uses the host ICU data and
 * orders `_`, digits and case differently, which made the TypeScript and
 * Python implementations emit schema objects in different orders.
 */
export function compareCodePoints(a: string, b: string): number {
  let aIndex = 0
  let bIndex = 0

  while (aIndex < a.length && bIndex < b.length) {
    const aPoint = a.codePointAt(aIndex) as number
    const bPoint = b.codePointAt(bIndex) as number
    if (aPoint !== bPoint) return aPoint < bPoint ? -1 : 1
    aIndex += aPoint > 0xffff ? 2 : 1
    bIndex += bPoint > 0xffff ? 2 : 1
  }

  return a.length - aIndex - (b.length - bIndex)
}
