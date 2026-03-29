import { exec } from 'node:child_process'
import { platform } from 'node:os'

import { getSession, pollDeviceToken, requestDeviceCode } from './api-client.js'
import { clearCredentials, loadCredentials, saveCredentials } from './credentials.js'

function openBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open'
  exec(`${cmd} ${JSON.stringify(url)}`, () => {
    // Silently ignore errors — user can open the URL manually
  })
}

export async function runLogin(baseUrl: string, print: (msg: string) => void): Promise<number> {
  const existing = await loadCredentials()
  if (existing) {
    try {
      const session = await getSession(existing.base_url, existing.access_token)
      print(`Already logged in as ${session.user.email}`)
      return 0
    } catch {
      // Token expired or invalid — proceed with fresh login
      await clearCredentials()
    }
  }

  const device = await requestDeviceCode(baseUrl)

  print(`\nOpen this URL in your browser:\n  ${device.verification_uri_complete}\n`)
  print(`Enter code: ${device.user_code}\n`)

  openBrowser(device.verification_uri_complete)

  print('Waiting for authorization...')

  const token = await pollDeviceToken(baseUrl, device.device_code, device.interval, device.expires_in)

  await saveCredentials({ access_token: token, base_url: baseUrl })

  const session = await getSession(baseUrl, token)
  print(`Logged in as ${session.user.email}`)

  return 0
}

export async function runLogout(print: (msg: string) => void): Promise<number> {
  await clearCredentials()
  print('Logged out.')
  return 0
}

export async function runWhoami(print: (msg: string) => void): Promise<number> {
  const creds = await loadCredentials()
  if (!creds) {
    print('Not logged in. Run `chkit obsessiondb login` to authenticate.')
    return 1
  }

  try {
    const session = await getSession(creds.base_url, creds.access_token)
    print(`Logged in as ${session.user.email} (${session.user.name})`)
    return 0
  } catch {
    await clearCredentials()
    print('Session expired. Run `chkit obsessiondb login` to re-authenticate.')
    return 1
  }
}
