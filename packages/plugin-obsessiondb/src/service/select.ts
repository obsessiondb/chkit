import { createInterface } from 'node:readline/promises'

import type { Service } from './types.js'

export async function selectServiceInteractive(
  services: Service[],
  print: (msg: string) => void
): Promise<Service | null> {
  if (services.length === 0) {
    print('No services found.')
    return null
  }

  const [onlyService] = services
  if (services.length === 1 && onlyService) {
    const service = onlyService
    print(`Auto-selected service: ${service.name} (${service.status})`)
    return service
  }

  print('\nAvailable services:')
  for (const [i, service] of services.entries()) {
    print(`  ${i + 1}. ${service.name} (${service.status})`)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`\nSelect service [1-${services.length}]: `)
    const index = parseInt(answer.trim(), 10) - 1
    const service = services[index]
    if (Number.isNaN(index) || !service) {
      print('Invalid selection.')
      return null
    }
    return service
  } finally {
    rl.close()
  }
}
