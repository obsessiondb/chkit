/** Turns `values` into a binary min-heap in place. */
export function heapify(values: number[]): void {
  for (let i = (values.length >> 1) - 1; i >= 0; i -= 1) siftDown(values, i)
}

export function heapPush(values: number[], value: number): void {
  values.push(value)
  for (let i = values.length - 1; i > 0; ) {
    const parent = (i - 1) >> 1
    if ((values[parent] ?? 0) <= value) break
    values[i] = values[parent] ?? 0
    values[parent] = value
    i = parent
  }
}

/** The smallest of the heap `values`, removed, or undefined when it is empty. */
export function heapPop(values: number[]): number | undefined {
  const top = values[0]
  const last = values.pop()
  if (values.length > 0 && last !== undefined) {
    values[0] = last
    siftDown(values, 0)
  }
  return top
}

function siftDown(values: number[], start: number): void {
  for (let i = start; ; ) {
    const left = 2 * i + 1
    const right = left + 1
    let smallest = i
    if (left < values.length && (values[left] ?? 0) < (values[smallest] ?? 0)) smallest = left
    if (right < values.length && (values[right] ?? 0) < (values[smallest] ?? 0)) smallest = right
    if (smallest === i) return
    const value = values[i] ?? 0
    values[i] = values[smallest] ?? 0
    values[smallest] = value
    i = smallest
  }
}
