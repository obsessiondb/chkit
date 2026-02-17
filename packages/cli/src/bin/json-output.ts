export type Command =
  | 'init'
  | 'generate'
  | 'codegen'
  | 'migrate'
  | 'status'
  | 'drift'
  | 'check'
  | 'plugin'
  | 'help'
  | 'version'

const JSON_CONTRACT_VERSION = 1

export function printOutput(value: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  if (typeof value === 'string') {
    console.log(value)
  }
}

export function jsonPayload<T extends object>(command: Command, payload: T): T & {
  command: Command
  schemaVersion: number
} {
  return {
    command,
    schemaVersion: JSON_CONTRACT_VERSION,
    ...payload,
  }
}

export function emitJson<T extends object>(command: Command, payload: T): void {
  printOutput(jsonPayload(command, payload), true)
}
