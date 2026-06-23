import { setTimeout as sleep } from 'node:timers/promises'

import type { Credentials } from '../auth/index.js'
import type { ApiClient } from '../client.js'
import { createApiClient } from '../client.js'
import { selectServiceInteractive, serviceChoiceLabel } from './select.js'
import { saveSelectedService } from './storage.js'
import type { Service } from './types.js'

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 5 * 60 * 1_000

/**
 * Claim a free ObsessionDB dev instance for the active org, wait for it to provision,
 * and persist it as the project's selected service.
 */
export async function runClaim(
  creds: Credentials,
  configPath: string,
  print: (msg: string) => void,
): Promise<number> {
  return claimInstanceFlow(createApiClient(creds), configPath, print)
}

/** Claim flow against an injected client — the unit-testable core of {@link runClaim}. */
export async function claimInstanceFlow(
  client: ApiClient,
  configPath: string,
  print: (msg: string) => void,
): Promise<number> {
  const status = await client.services.instanceClaimStatus({})
  if (!status.eligible) {
    print(`You already have a free instance in organization "${status.claimedOrganizationName}".`)
    return selectExistingInstance(client, configPath, print)
  }

  const result = await client.services.claimInstance({})
  if (result.outcome === 'none_available') {
    print('No free dev instances are available right now. We have been notified — please try again later.')
    return 1
  }
  if (result.outcome === 'already_claimed') {
    print(`You already have a free instance in organization "${result.claimedOrganizationName}".`)
    return selectExistingInstance(client, configPath, print)
  }

  print(`Claimed a free instance (${result.slug}). Provisioning — this can take a minute…`)

  const service = await pollUntilRunning(client, result.slug, print)
  if (!service) {
    print('Instance is still provisioning. Run `chkit obsessiondb service select` once it is ready.')
    return 1
  }

  await saveSelectedService(configPath, {
    service_slug: service.slug,
    service_name: service.name,
  })
  print(`Instance ready: ${service.name} (${service.slug}).`)
  return 0
}

async function pollUntilRunning(
  client: ApiClient,
  slug: string,
  print: (msg: string) => void,
): Promise<Service | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const service = await client.services.get({ serviceSlug: slug })
    if (service.status === 'running') return service
    if (service.status === 'error' || service.status === 'terminated') {
      print(`Provisioning failed — instance entered status "${service.status}".`)
      return null
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return null
}

async function selectExistingInstance(
  client: ApiClient,
  configPath: string,
  print: (msg: string) => void,
): Promise<number> {
  const { organizations } = await client.services.listAll({})
  const selected = await selectServiceInteractive(organizations, print)
  if (!selected) return 1

  await saveSelectedService(configPath, {
    service_slug: selected.service.slug,
    service_name: selected.service.name,
  })
  print(`Service selected: ${serviceChoiceLabel(selected)}`)
  return 0
}
