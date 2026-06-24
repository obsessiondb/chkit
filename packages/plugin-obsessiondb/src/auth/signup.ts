import process from 'node:process'
import { cancel, isCancel, text } from '@clack/prompts'

import {
  CLAIM_COMMAND,
  errorEnvelope,
  noEmailEnvelope,
  otpSentEnvelope,
  SIGNUP_EMAIL_COMMAND,
  verifiedEnvelope,
  verifyCodeCommand,
} from '../json-envelope.js'
import {
  createOrganization,
  getSession,
  OtpRateLimitError,
  sendVerificationOtp,
  setActiveOrganization,
  verifyOtp,
} from './api-client.js'
import { saveCredentials } from './credentials.js'

export interface SignupOptions {
  /** Skip the email prompt (non-interactive / tests). */
  email?: string
  /** Skip the code prompt (non-interactive / tests). Presence means "verify step": the OTP is not re-sent. */
  code?: string
  /** Override the auto-derived organization name. */
  orgName?: string
  /** Only send the OTP and print the follow-up command, then stop (step 1 of the 2-step flow). */
  requestOnly?: boolean
  /** Emit a structured `--json` envelope at each state instead of the prose runbook. */
  jsonMode?: boolean
}

/**
 * Passwordless signup/login driven entirely by the CLI:
 * email → one-time code → durable bearer credential → personal org (auto-created).
 *
 * Three modes share this one path:
 *  - Interactive (TTY): send → prompt for code → verify, all in one process.
 *  - Two-step non-interactive: `--email [--request-only]` sends the code and prints the exact
 *    follow-up command; a second run with `--email --code <CODE>` verifies. The OTP binding
 *    lives server-side keyed by email, so nothing has to persist on the client between runs.
 *  - Scripted/test: pass `--email` and `--code` together; the code's presence skips the re-send.
 *
 * With `jsonMode`, each terminal/pause state emits a structured `{ status, next }` envelope
 * (see json-envelope.ts) instead of prose, so a `--json` pipe stays valid.
 */
export async function runSignup(
  baseUrl: string,
  print: (value: unknown) => void,
  options: SignupOptions = {},
): Promise<number> {
  const jsonMode = options.jsonMode === true
  const email = options.email ?? (await promptEmail(print, jsonMode))
  if (email === null) return 1

  // A supplied code means this is the verify step of a prior request — re-sending would
  // invalidate the code the caller is about to submit, so only send when we have no code yet.
  if (options.code === undefined) {
    try {
      await sendVerificationOtp(baseUrl, email)
    } catch (error) {
      if (error instanceof OtpRateLimitError) {
        if (jsonMode) print(errorEnvelope('obsessiondb signup', 'otp_rate_limited', error.message))
        else print(error.message)
        return 1
      }
      throw error
    }
    if (!jsonMode) print(`We sent a 6-digit code to ${email}.`)

    // No way to prompt for the code in this process (explicit --request-only, or no TTY).
    // Hand the caller the exact follow-up command and stop — the send already succeeded.
    if (options.requestOnly || !process.stdin.isTTY) {
      if (jsonMode) print(otpSentEnvelope(email))
      else print(verifyStepHint(email).join('\n'))
      return 0
    }
  }

  const code = options.code ?? (await promptCode(print, jsonMode))
  if (code === null) return 1

  const { token, user } = await verifyOtp(baseUrl, email, code)
  await saveCredentials({ access_token: token, base_url: baseUrl })

  const created = await ensureActiveOrganization(baseUrl, token, {
    email,
    orgName: options.orgName,
  })
  if (jsonMode) {
    print(verifiedEnvelope(email))
  } else if (created) {
    print(`Created organization "${created}".`)
    print(`Signed in as ${user.email}.`)
  } else {
    print(`Welcome back, ${user.email}.`)
  }

  return 0
}

/**
 * Ensure the session has an active organization, auto-creating a personal one if not.
 * Returns the created org name, or null if the user already had an active org.
 */
async function ensureActiveOrganization(
  baseUrl: string,
  token: string,
  input: { email: string; orgName?: string },
): Promise<string | null> {
  const session = await getSession(baseUrl, token)
  if (session.session?.activeOrganizationId) return null

  const name = input.orgName ?? deriveOrgName(input.email)
  const slug = slugifyOrgName(name)
  const { id } = await createOrganization(baseUrl, token, { name, slug })
  await setActiveOrganization(baseUrl, token, id)
  return name
}

/** Full two-step recipe shown when no email is available in a non-interactive run. */
export function signupEmailRunbook(): string[] {
  return [
    'No email provided. In non-interactive environments, sign up in two steps:',
    `  1. ${SIGNUP_EMAIL_COMMAND}          # sends a 6-digit code`,
    `  2. ${verifyCodeCommand('<you@example.com>')}   # verifies and signs in`,
    `Then claim a service: ${CLAIM_COMMAND}`,
  ]
}

/** Follow-up commands shown after a code has been sent to `email` (the verify step). */
export function verifyStepHint(email: string): string[] {
  return [`Next: ${verifyCodeCommand(email)}`, `Then: ${CLAIM_COMMAND}`]
}

async function promptEmail(
  print: (value: unknown) => void,
  jsonMode: boolean,
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    if (jsonMode) print(noEmailEnvelope())
    else print(signupEmailRunbook().join('\n'))
    return null
  }
  const value = await text({
    message: 'Enter your email to sign up or log in:',
    validate: (v) => (v?.includes('@') ? undefined : 'Enter a valid email address.'),
  })
  if (isCancel(value)) {
    cancel('Signup cancelled.')
    return null
  }
  return value.trim()
}

async function promptCode(
  print: (value: unknown) => void,
  jsonMode: boolean,
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    if (jsonMode) {
      print(errorEnvelope('obsessiondb signup', 'code_required', 'No code provided. Re-run with --code <code>.'))
    } else {
      print('No code provided. Re-run with --code <code> in non-interactive environments.')
    }
    return null
  }
  const value = await text({
    message: 'Enter the 6-digit code from your email:',
    validate: (v) => (v && /^\d{6}$/.test(v.trim()) ? undefined : 'Enter the 6-digit code.'),
  })
  if (isCancel(value)) {
    cancel('Signup cancelled.')
    return null
  }
  return value.trim()
}

/** Derive a personal org name from the email local-part; fallback to `playground`. */
export function deriveOrgName(email: string): string {
  // Drop the +subaddress (everything from the first '+' to the '@') and any non-display chars so a
  // plus-addressed email like `marc+clisignup@…` yields `marc`, not `marc+clisignup`.
  const localPart = email.split('@')[0]?.split('+')[0] ?? ''
  const cleaned = localPart.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '')
  return cleaned.length > 0 ? cleaned : 'playground'
}

/** Build a unique-ish org slug from a name (random suffix avoids collisions across machines). */
export function slugifyOrgName(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      // The line above already collapsed every run to a single '-', so a leading/trailing dash is
      // never doubled. Matching one char (not `-+`) avoids the polynomial-backtracking pattern.
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'playground'
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${base}-${suffix}`
}
