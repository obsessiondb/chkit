import { setTimeout as sleep } from 'node:timers/promises'

import type { Credentials } from '../auth/index.js'
import type { ApiClient } from '../client.js'
import { createApiClient } from '../client.js'
import {
  alreadyClaimedEnvelope,
  claimedEnvelope,
  errorEnvelope,
  provisioningEnvelope,
} from '../json-envelope.js'
import { selectServiceInteractive, serviceChoiceLabel } from './select.js'
import { saveSelectedService } from './storage.js'
import type { Service } from './types.js'

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 5 * 60 * 1_000
const CLAIM_COMMAND_ID = 'obsessiondb service claim'

/**
 * Claim a free ObsessionDB dev instance for the active org, wait for it to provision,
 * and persist it as the project's selected service.
 *
 * With `jsonMode`, each terminal state emits a structured `--json` envelope instead of prose,
 * and the already-claimed paths return a `service select` hint rather than dropping into the
 * interactive picker (which can't run without a TTY).
 */
export async function runClaim(
  creds: Credentials,
  configPath: string,
  print: (value: unknown) => void,
  jsonMode = false,
): Promise<number> {
  return claimInstanceFlow(createApiClient(creds), configPath, print, jsonMode)
}

/** Claim flow against an injected client — the unit-testable core of {@link runClaim}. */
export async function claimInstanceFlow(
  client: ApiClient,
  configPath: string,
  print: (value: unknown) => void,
  jsonMode = false,
): Promise<number> {
  const status = await client.services.instanceClaimStatus({})
  if (!status.eligible) {
    if (jsonMode) {
      print(alreadyClaimedEnvelope())
      return 0
    }
    print(`You already have a free instance in organization "${status.claimedOrganizationName}".`)
    return selectExistingInstance(client, configPath, print)
  }

  const result = await client.services.claimInstance({})
  if (result.outcome === 'none_available') {
    const message = 'No free dev instances are available right now. We have been notified — please try again later.'
    if (jsonMode) print(errorEnvelope(CLAIM_COMMAND_ID, 'none_available', message))
    else print(message)
    return 1
  }
  if (result.outcome === 'already_claimed') {
    if (jsonMode) {
      print(alreadyClaimedEnvelope())
      return 0
    }
    print(`You already have a free instance in organization "${result.claimedOrganizationName}".`)
    return selectExistingInstance(client, configPath, print)
  }

  if (!jsonMode) print(`Claimed a free instance (${result.slug}). Provisioning — this can take a minute…`)

  const service = await pollUntilRunning(client, result.slug, print, jsonMode)
  if (!service) {
    if (jsonMode) print(provisioningEnvelope())
    else print('Instance is still provisioning. Run `chkit obsessiondb service select` once it is ready.')
    return 1
  }

  const selected = { service_slug: service.slug, service_name: service.name }
  await saveSelectedService(configPath, selected)
  if (jsonMode) print(claimedEnvelope(selected))
  else print(`Instance ready: ${service.name} (${service.slug}).`)
  return 0
}

async function pollUntilRunning(
  client: ApiClient,
  slug: string,
  print: (value: unknown) => void,
  jsonMode: boolean,
): Promise<Service | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const service = await client.services.get({ serviceSlug: slug })
    if (service.status === 'running') return service
    if (service.status === 'error' || service.status === 'terminated') {
      if (!jsonMode) print(`Provisioning failed — instance entered status "${service.status}".`)
      return null
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return null
}

async function selectExistingInstance(
  client: ApiClient,
  configPath: string,
  print: (value: unknown) => void,
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
