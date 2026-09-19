import type { ErrorClassifier, FailureClass } from './types.js'

const DIAGNOSTIC_BODY_LIMIT = 2048
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

export class IngestConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IngestConfigError'
  }
}

/**
 * Canonical boundary for fetch-based readers when `response.ok` is false.
 * Keeps normalized HTTP facts plus the original Response for raw inspection.
 */
export class HttpError extends Error {
  readonly status: number
  readonly statusText: string
  readonly url: string
  readonly retryAfterMs: number | undefined
  readonly body: string
  readonly response: Response

  private constructor(response: Response, body: string) {
    super(`HTTP ${response.status} ${response.statusText} for ${redactUrl(response.url)}${body ? `: ${body}` : ''}`)
    this.name = 'HttpError'
    this.status = response.status
    this.statusText = response.statusText
    this.url = redactUrl(response.url)
    this.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    this.body = body
    this.response = response
  }

  static async fromResponse(response: Response): Promise<HttpError> {
    const body = await readDiagnosticBody(response)
    return new HttpError(response, body)
  }
}

/** Executor-owned failure that always preserves the exact thrown value. */
export class FetchFailure extends Error {
  readonly classification: FailureClass
  override readonly cause: unknown

  constructor(cause: unknown, classification: FailureClass) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'FetchFailure'
    this.cause = cause
    this.classification = classification
  }
}

export class BudgetExhausted extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetExhausted'
  }
}

/**
 * Cancellation is authoritative, then the common HTTP/network fallback is
 * derived, then an optional provider classifier may enrich or override it.
 */
export function classifyFailure(
  cause: unknown,
  signal: AbortSignal,
  classifier: ErrorClassifier | undefined
): FailureClass {
  if (signal.aborted || isAbortError(cause)) return { kind: 'cancelled' }
  const fallback = classifyCommon(cause)
  return classifier?.(cause, fallback) ?? fallback
}

function classifyCommon(cause: unknown): FailureClass {
  if (cause instanceof HttpError) {
    if (cause.status === 429) return { kind: 'rate_limited', retryAfterMs: cause.retryAfterMs }
    if (cause.status === 408 || cause.status === 425 || cause.status >= 500) return { kind: 'transient' }
    if (cause.status >= 400) return { kind: 'permanent' }
    return { kind: 'unknown' }
  }
  const code = errorCode(cause)
  if (code !== undefined && TRANSIENT_NETWORK_CODES.has(code)) return { kind: 'transient' }
  if (cause instanceof TypeError && /fetch failed|network|socket/i.test(cause.message)) return { kind: 'transient' }
  if (cause instanceof Error && cause.name === 'TimeoutError') return { kind: 'transient' }
  return { kind: 'unknown' }
}

export function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError'
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if ('code' in value && typeof value.code === 'string') return value.code
  if ('cause' in value) return errorCode(value.cause)
  return undefined
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

async function readDiagnosticBody(response: Response): Promise<string> {
  try {
    const text = await response.clone().text()
    return text.length > DIAGNOSTIC_BODY_LIMIT ? `${text.slice(0, DIAGNOSTIC_BODY_LIMIT)}…` : text
  } catch {
    return ''
  }
}

// Query strings may carry API keys; keep only origin and path in diagnostics.
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}
