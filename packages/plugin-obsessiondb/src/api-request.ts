import type { Credentials } from './auth/index.js'

export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired. Run `chkit obsessiondb login` to re-authenticate.')
  }
}

export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof SessionExpiredError
}

export async function apiRequest<T>(
  path: string,
  creds: Credentials,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${creds.base_url}${path}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'chkit-cli',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  if (res.status === 401) {
    throw new SessionExpiredError()
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API error: ${res.status} ${text}`)
  }

  return (await res.json()) as T
}
