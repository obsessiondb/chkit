export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export interface SessionResponse {
  user: {
    id: string
    name: string
    email: string
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
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Token poll failed: ${res.status} ${text}`)
    }

    const body = (await res.json()) as TokenPollResponse

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
