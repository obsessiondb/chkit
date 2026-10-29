type Command =
  | 'add'
  | 'registry'
  | 'generate'
  | 'migrate'
  | 'status'
  | 'drift'
  | 'check'
  | 'snapshot'
  | 'plugin'
  | 'query'

const JSON_CONTRACT_VERSION = 1

let jsonEmitted = false

/** Whether any JSON payload (success or error) has already been written to stdout. */
export function hasEmittedJson(): boolean {
  return jsonEmitted
}

let stdoutDrain: Promise<void> | undefined
let resolveStdoutDrain: (() => void) | undefined
let stdoutListening = false
let stdoutClosed = false

function settleStdoutDrain(): void {
  stdoutDrain = undefined
  resolveStdoutDrain?.()
  resolveStdoutDrain = undefined
}

/**
 * Write a line to stdout through the stream. Bun's `console.log` drops whatever
 * does not fit in a 64 KiB pipe buffer once stdout is non-blocking, and
 * `process.exit` drops what the stream has not flushed yet, so remember a
 * pending drain for the exit path to await (`stdoutDrained`).
 *
 * A reader that closes early (`| head`) makes the write fail with EPIPE. Node's
 * console swallows that; a bare stream write would crash on the unhandled
 * `'error'` event, so handle it here: stop writing and settle the drain so the
 * CLI still exits with the command's own code.
 */
export function writeStdout(text: string): void {
  if (!stdoutListening) {
    stdoutListening = true
    process.stdout.on('error', () => {
      stdoutClosed = true
      settleStdoutDrain()
    })
  }
  if (stdoutClosed) return
  if (process.stdout.write(`${text}\n`) || stdoutDrain) return
  stdoutDrain = new Promise((resolve) => {
    resolveStdoutDrain = resolve
  })
  process.stdout.once('drain', settleStdoutDrain)
}

/** Resolves once everything written with `writeStdout` has been flushed. */
export function stdoutDrained(): Promise<void> {
  return stdoutDrain ?? Promise.resolve()
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
    writeStdout(JSON.stringify(payload, null, 2))
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
  writeStdout(JSON.stringify(buildJsonErrorEnvelope(command, error), null, 2))
}
