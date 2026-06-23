interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

interface SessionResponse {
  user: {
    id: string
    name: string
    email: string
  }
  session?: {
    activeOrganizationId?: string | null
  }
}

interface VerifiedUser {
  id: string
  email: string
  name?: string
}

export interface OtpVerifyResult {
  token: string
  user: VerifiedUser
}

/** Thrown when the send-OTP endpoint is rate-limited (HTTP 429). */
export class OtpRateLimitError extends Error {
  constructor() {
    super('Too many code requests. Please wait a minute and try again.')
    this.name = 'OtpRateLimitError'
  }
}

const CLIENT_ID = 'chkit-cli'

function userAgent(): string {
  // Avoid importing package.json — use a hardcoded prefix; version is non-critical here
  return 'chkit-cli'
}

export async function requestDeviceCode(baseUrl: string): Promise<DeviceCodeResponse> {
  const res = await fetch(`${baseUrl}/api/auth/device/code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent(),
    },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to request device code: ${res.status} ${text}`)
  }
  return (await res.json()) as DeviceCodeResponse
}

type TokenPollError = 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token'

interface TokenPollResponse {
  access_token?: string
  error?: TokenPollError
}

export async function pollDeviceToken(
  baseUrl: string,
  deviceCode: string,
  interval: number,
  expiresIn: number
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000
  let pollInterval = interval * 1000

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval))

    const res = await fetch(`${baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent(),
      },
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    })

    const body = (await res.json()) as TokenPollResponse

    if (!body.access_token && !body.error) {
      throw new Error(`Token poll failed: ${res.status} ${JSON.stringify(body)}`)
    }

    if (body.access_token) return body.access_token

    switch (body.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        pollInterval += 5000
        continue
      case 'access_denied':
        throw new Error('Authorization denied by user.')
      case 'expired_token':
        throw new Error('Device code expired. Please try again.')
      default:
        throw new Error(`Unexpected token poll response: ${JSON.stringify(body)}`)
    }
  }

  throw new Error('Device code expired. Please try again.')
}

export async function getSession(baseUrl: string, token: string): Promise<SessionResponse> {
  const res = await fetch(`${baseUrl}/api/auth/get-session`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': userAgent(),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to get session: ${res.status} ${text}`)
  }
  return (await res.json()) as SessionResponse
}

/**
 * Passwordless signup/login — step 1: request a one-time code by email.
 * `type: "sign-in"` covers both new and existing users (unknown emails create a verified user).
 */
export async function sendVerificationOtp(baseUrl: string, email: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent(),
    },
    body: JSON.stringify({ email, type: 'sign-in' }),
  })
  if (res.status === 429) throw new OtpRateLimitError()
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to send verification code: ${res.status} ${text}`)
  }
}

/**
 * Passwordless signup/login — step 2: verify the code.
 * The bearer credential is returned in the `set-auth-token` response header (not the JSON body).
 */
export async function verifyOtp(baseUrl: string, email: string, otp: string): Promise<OtpVerifyResult> {
  const res = await fetch(`${baseUrl}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent(),
    },
    body: JSON.stringify({ email, otp }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to verify code: ${res.status} ${text}`)
  }
  const token = res.headers.get('set-auth-token')
  if (!token) {
    throw new Error('Verification succeeded but no auth token was returned by the server.')
  }
  const body = (await res.json()) as { user: VerifiedUser }
  return { token, user: body.user }
}

export async function createOrganization(
  baseUrl: string,
  token: string,
  input: { name: string; slug: string },
): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/api/auth/organization/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent(),
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to create organization: ${res.status} ${text}`)
  }
  return (await res.json()) as { id: string }
}

export async function setActiveOrganization(
  baseUrl: string,
  token: string,
  organizationId: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/auth/organization/set-active`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent(),
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ organizationId }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to set active organization: ${res.status} ${text}`)
  }
}
