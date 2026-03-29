import process from 'node:process'

const enabled = process.env.CHKIT_DEBUG === '1' || process.env.CHKIT_DEBUG === 'true'

function timestamp(): string {
  const now = new Date()
  return now.toISOString().slice(11, 23) // HH:mm:ss.SSS
}

export function debug(category: string, message: string, detail?: unknown): void {
  if (!enabled) return
  const prefix = `[chkit:${category}]`
  if (detail !== undefined) {
    console.error(`${timestamp()} ${prefix} ${message}`, detail)
  } else {
    console.error(`${timestamp()} ${prefix} ${message}`)
  }
}

export function isDebugEnabled(): boolean {
  return enabled
}
