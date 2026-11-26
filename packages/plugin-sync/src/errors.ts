import { z } from 'zod'

import type { FailureClass } from './types.js'

const DIAGNOSTIC_BODY_LIMIT = 2048
const MAX_CAUSE_DEPTH = 16
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

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

  private constructor(response: Response, details: { status: number; statusText: string; body: string; retryAfterMs: number | undefined }) {
    const status = [String(details.status), details.statusText].filter(Boolean).join(' ')
    const url = redactUrl(response.url)
    super(`HTTP ${status}${url ? ` for ${url}` : ''}${details.body ? `: ${details.body}` : ''}`)
    this.name = 'HttpError'
    this.status = details.status
    this.statusText = details.statusText
    this.url = url
    this.retryAfterMs = details.retryAfterMs
    this.body = details.body
    this.response = response
  }

  static async fromResponse(response: Response): Promise<HttpError> {
    return new HttpError(response, {
      status: response.status,
      statusText: response.statusText,
      body: await readDiagnosticBody(response),
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    })
  }

  /** A failure a provider reports inside a successful response, as the HTTP status it means. */
  static withStatus(response: Response, status: number, options: { body?: string; retryAfterMs?: number } = {}): HttpError {
    return new HttpError(response, {
      status,
      statusText: '',
      body: limitBody(options.body ?? ''),
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) ?? options.retryAfterMs,
    })
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

export function describeError(error: unknown): string {
  if (error instanceof z.ZodError) return z.prettifyError(error)
  return error instanceof Error ? error.message : String(error)
}

/** Cancellation is authoritative over whatever the failure looks like. */
export function classifyFailure(cause: unknown, signal: AbortSignal): FailureClass {
  if (signal.aborted) return { kind: 'cancelled' }
  for (const error of causeChain(cause)) {
    if (error instanceof HttpError) return classifyStatus(error)
    if ('code' in error && typeof error.code === 'string' && TRANSIENT_NETWORK_CODES.has(error.code)) return { kind: 'transient' }
    // A request's own timeout/abort does not cancel the ingestion execution.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { kind: 'transient' }
  }
  return { kind: 'unknown' }
}

function classifyStatus(error: HttpError): FailureClass {
  if (error.status === 429) return { kind: 'rate_limited', retryAfterMs: error.retryAfterMs }
  if (error.status === 408 || error.status === 425 || error.status >= 500) return { kind: 'transient' }
  if (error.status >= 400) return { kind: 'permanent' }
  return { kind: 'unknown' }
}

function* causeChain(value: unknown): Generator<object> {
  let current = value
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
    yield current
    current = 'cause' in current ? current.cause : undefined
  }
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
    return limitBody(await response.clone().text())
  } catch {
    return ''
  }
}

function limitBody(text: string): string {
  return text.length > DIAGNOSTIC_BODY_LIMIT ? `${text.slice(0, DIAGNOSTIC_BODY_LIMIT)}…` : text
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
