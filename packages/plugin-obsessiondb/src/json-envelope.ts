import type { SelectedService } from './service/types.js'

/**
 * Schema version for obsessiondb `--json` envelopes. Mirrors the CLI's JSON contract version
 * (`packages/cli/src/runtime/json-output.ts`); duplicated rather than imported because the CLI
 * depends on this package, not the other way around.
 */
export const JSON_CONTRACT_VERSION = 1

// --- Next-step command strings -------------------------------------------------------------
// Single source for the commands a non-interactive caller runs next, shared by both the prose
// runbooks (auth/signup.ts) and the JSON envelopes below so the two can never drift.

/** Step 1 of the non-interactive signup: request a code (placeholder email until one is known). */
export const SIGNUP_EMAIL_COMMAND = 'chkit obsessiondb signup --email <you@example.com>'
/** Claim a free dev instance after signing in. */
export const CLAIM_COMMAND = 'chkit obsessiondb service claim'
/** Pick an instance once one exists / finishes provisioning. */
export const SERVICE_SELECT_COMMAND = 'chkit obsessiondb service select'

/** Step 2 of the non-interactive signup: verify the emailed code for a known email. */
export function verifyCodeCommand(email: string): string {
  return `chkit obsessiondb signup --email ${email} --code <CODE>`
}

// --- Envelope shape ------------------------------------------------------------------------

const SIGNUP_COMMAND_ID = 'obsessiondb signup'
const CLAIM_COMMAND_ID = 'obsessiondb service claim'

/** Machine-readable hint telling a non-interactive caller what to run next. */
export interface NextAction {
  /** The input the next step needs, e.g. "email", "code", "claim", "select". */
  needs: string
  /** The exact command to run next. */
  command: string
}

/** Structured `--json` envelope for the linear signup → claim flow. `next` is null at a terminal state. */
export interface NextEnvelope {
  command: string
  schemaVersion: number
  status: string
  email?: string
  service?: SelectedService
  next: NextAction | null
}

/** Stable error envelope mirroring the CLI's `JsonErrorEnvelope` for `--json` consumers. */
export interface ErrorEnvelope {
  command: string
  schemaVersion: number
  ok: false
  error: { code: string; message: string }
}

// --- Builders (one per emitted state) ------------------------------------------------------

/** signup with no email in a non-interactive run: the caller must supply `--email` to start. */
export function noEmailEnvelope(): NextEnvelope {
  return envelope(SIGNUP_COMMAND_ID, 'no_email', { needs: 'email', command: SIGNUP_EMAIL_COMMAND })
}

/** signup `--email` sent a code and paused: the caller must re-run with `--code`. */
export function otpSentEnvelope(email: string): NextEnvelope {
  return envelope(SIGNUP_COMMAND_ID, 'otp_sent', { needs: 'code', command: verifyCodeCommand(email) }, { email })
}

/** signup verified and signed in: the caller can now claim an instance. */
export function verifiedEnvelope(email: string): NextEnvelope {
  return envelope(SIGNUP_COMMAND_ID, 'verified', { needs: 'claim', command: CLAIM_COMMAND }, { email })
}

/** claim succeeded and the instance is running: terminal, no next action. */
export function claimedEnvelope(service: SelectedService): NextEnvelope {
  return envelope(CLAIM_COMMAND_ID, 'claimed', null, { service })
}

/** claim started but the instance is still provisioning: the caller should select it once ready. */
export function provisioningEnvelope(): NextEnvelope {
  return envelope(CLAIM_COMMAND_ID, 'provisioning', { needs: 'select', command: SERVICE_SELECT_COMMAND })
}

/** The org already has an instance: the caller should select one rather than claim. */
export function alreadyClaimedEnvelope(): NextEnvelope {
  return envelope(CLAIM_COMMAND_ID, 'already_claimed', { needs: 'select', command: SERVICE_SELECT_COMMAND })
}

/** Terminal failure (e.g. no capacity, rate limit): a `--json` pipe stays valid. */
export function errorEnvelope(command: string, code: string, message: string): ErrorEnvelope {
  return { command, schemaVersion: JSON_CONTRACT_VERSION, ok: false, error: { code, message } }
}

/** `whoami` for an authenticated session: terminal, no next action. */
export function whoamiEnvelope(user: { email: string; name?: string }): NextEnvelope {
  return {
    command: 'obsessiondb whoami',
    schemaVersion: JSON_CONTRACT_VERSION,
    status: 'logged_in',
    email: user.email,
    next: null,
  }
}

/** A single ObsessionDB service in a `service list` envelope. */
export interface ServiceListEntry {
  organization: string
  slug: string
  name: string
  selected: boolean
}

/** Structured `service list` output for `--json` consumers (one object, not per-line strings). */
export interface ServiceListEnvelope {
  command: string
  schemaVersion: number
  status: 'ok'
  services: ServiceListEntry[]
}

export function serviceListEnvelope(services: ServiceListEntry[]): ServiceListEnvelope {
  return {
    command: 'obsessiondb service list',
    schemaVersion: JSON_CONTRACT_VERSION,
    status: 'ok',
    services,
  }
}

function envelope(
  command: string,
  status: string,
  next: NextAction | null,
  extra?: { email?: string; service?: SelectedService },
): NextEnvelope {
  return {
    command,
    schemaVersion: JSON_CONTRACT_VERSION,
    status,
    ...(extra?.email !== undefined ? { email: extra.email } : {}),
    ...(extra?.service !== undefined ? { service: extra.service } : {}),
    next,
  }
}
