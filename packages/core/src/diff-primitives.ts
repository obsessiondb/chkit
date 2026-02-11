export interface NamedDiffChange<T> {
  name: string
  oldItem: T
  newItem: T
}

export interface NamedDiffResult<T> {
  added: T[]
  removed: T[]
  changed: NamedDiffChange<T>[]
}

export function diffByName<T>(
  oldItems: readonly T[],
  newItems: readonly T[],
  getName: (item: T) => string,
  equals: (left: T, right: T) => boolean
): NamedDiffResult<T> {
  const oldByName = new Map(oldItems.map((item) => [getName(item), item]))
  const newNames = new Set(newItems.map((item) => getName(item)))
  const added: T[] = []
  const changed: NamedDiffChange<T>[] = []
  const removed: T[] = []

  for (const newItem of newItems) {
    const name = getName(newItem)
    const oldItem = oldByName.get(name)
    if (!oldItem) {
      added.push(newItem)
      continue
    }
    if (!equals(oldItem, newItem)) {
      changed.push({ name, oldItem, newItem })
    }
  }

  for (const oldItem of oldItems) {
    const name = getName(oldItem)
    if (!newNames.has(name)) {
      removed.push(oldItem)
    }
  }

  return {
    added,
    removed,
    changed,
  }
}

export interface SettingDiffResult {
  changes: Array<
    | { kind: 'modify'; key: string; value: string | number | boolean }
    | { kind: 'reset'; key: string }
  >
}

export function diffSettings(
  oldSettings: Record<string, string | number | boolean>,
  newSettings: Record<string, string | number | boolean>
): SettingDiffResult {
  const keys = [...new Set([...Object.keys(oldSettings), ...Object.keys(newSettings)])].sort()
  const changes: SettingDiffResult['changes'] = []

  for (const key of keys) {
    const hadValue = key in oldSettings
    const nextValue = newSettings[key]
    if (nextValue === undefined) {
      if (hadValue) changes.push({ kind: 'reset', key })
      continue
    }
    if (!hadValue || oldSettings[key] !== nextValue) {
      changes.push({ kind: 'modify', key, value: nextValue })
    }
  }

  return {
    changes,
  }
}

export interface ClauseComparison {
  oldValue: string
  newValue: string
}

export function diffClauses(comparisons: readonly ClauseComparison[]): boolean {
  return comparisons.some((comparison) => comparison.oldValue !== comparison.newValue)
}
