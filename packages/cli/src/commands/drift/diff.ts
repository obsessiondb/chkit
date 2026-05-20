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
  actualSettings: Record<string, string>
): string[] {
  const settingKeys = Object.keys(expectedSettings).sort()
  const diffs: string[] = []
  for (const key of settingKeys) {
    const left = key in expectedSettings ? String(expectedSettings[key]) : ''
    const right = key in actualSettings ? String(actualSettings[key]) : ''
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
  const keys = [...new Set([...expected.keys(), ...actual.keys()])].sort()
  const diffs: string[] = []
  for (const key of keys) {
    if ((expected.get(key) ?? '') !== (actual.get(key) ?? '')) {
      diffs.push(key)
    }
  }
  return diffs
}
