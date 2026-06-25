type Command =
  | 'generate'
  | 'migrate'
  | 'status'
  | 'drift'
  | 'check'
  | 'plugin'
  | 'query'

const JSON_CONTRACT_VERSION = 1

let jsonEmitted = false

/** Whether any JSON payload (success or error) has already been written to stdout. */
export function hasEmittedJson(): boolean {
  return jsonEmitted
}

export function printOutput(value: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    jsonEmitted = true
    // Catch-all: never emit a bare JSON string. A command that prints a plain
    // string under `--json` (e.g. a status line) is wrapped in a minimal object
    // so the output is always a parseable object for `jq` consumers.
    const payload =
      typeof value === 'string'
        ? { schemaVersion: JSON_CONTRACT_VERSION, message: value }
        : value
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  if (typeof value === 'string') {
    console.log(value)
  }
}

function jsonPayload<T extends object>(command: Command, payload: T): T & {
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

export interface JsonError {
  code: string
  message: string
  hint?: string
}

export interface JsonErrorEnvelope {
  command: string
  schemaVersion: number
  ok: false
  error: JsonError
}

export function buildJsonErrorEnvelope(command: string, error: JsonError): JsonErrorEnvelope {
  return {
    command,
    schemaVersion: JSON_CONTRACT_VERSION,
    ok: false,
    error,
  }
}

/**
 * Emit a stable machine-readable error envelope to stdout for `--json` consumers.
 * Without this, a thrown error left stdout empty and printed plain text to
 * stderr, breaking any pipe to `jq` on the first failure.
 */
export function emitJsonError(command: string, error: JsonError): void {
  jsonEmitted = true
  console.log(JSON.stringify(buildJsonErrorEnvelope(command, error), null, 2))
}
