import { compareCodePoints, settingValueFingerprint } from '@chkit/core'

export function diffByName<T>(
  expectedItems: readonly T[],
  actualItems: readonly T[],
  getName: (item: T) => string,
  getShape: (item: T) => string
): { missing: string[]; extra: string[]; changed: string[] } {
  const expected = new Map(expectedItems.map((item) => [getName(item), getShape(item)]))
  const actual = new Map(actualItems.map((item) => [getName(item), getShape(item)]))
  const missing: string[] = []
  const extra: string[] = []
  const changed: string[] = []

  for (const [name, expectedShape] of expected.entries()) {
    const actualShape = actual.get(name)
    if (!actualShape) {
      missing.push(name)
      continue
    }
    if (actualShape !== expectedShape) {
      changed.push(name)
    }
  }

  for (const name of actual.keys()) {
    if (!expected.has(name)) {
      extra.push(name)
    }
  }

  return { missing, extra, changed }
}

export function diffSettings(
  expectedSettings: Record<string, string | number | boolean>,
  actualSettings: Record<string, string | number | boolean>
): string[] {
  const settingKeys = Object.keys(expectedSettings).sort(compareCodePoints)
  const diffs: string[] = []
  for (const key of settingKeys) {
    const left = key in expectedSettings ? settingValueFingerprint(expectedSettings[key] ?? '') : ''
    const right = key in actualSettings ? settingValueFingerprint(actualSettings[key] ?? '') : ''
    if (left !== right) {
      diffs.push(key)
    }
  }
  return diffs
}

export function diffNamedShapeMaps(
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string>
): string[] {
  // Code-point order, like every other name comparison here: a bare sort()
  // compares UTF-16 units, so U+E000 and U+1F600 come out in the opposite
  // order from Python's str ordering and live drift reports only one side.
  const keys = [...new Set([...expected.keys(), ...actual.keys()])].sort(compareCodePoints)
  const diffs: string[] = []
  for (const key of keys) {
    if ((expected.get(key) ?? '') !== (actual.get(key) ?? '')) {
      diffs.push(key)
    }
  }
  return diffs
}
