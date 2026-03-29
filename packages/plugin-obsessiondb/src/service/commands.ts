import { loadCredentials, resolveBaseUrl } from '../auth/index.js'
import { listServices } from './api.js'
import { selectServiceInteractive } from './select.js'
import { saveSelectedService } from './storage.js'

interface PluginCommandContext {
  configPath: string
  flags: Record<string, string | string[] | boolean | undefined>
  print: (value: unknown) => void
}

interface PluginCommand {
  name: string
  description: string
  run: (context: PluginCommandContext) => Promise<number>
}

export const SELECT_SERVICE_COMMAND: PluginCommand = {
  name: 'select-service',
  description: 'Select an ObsessionDB service for query routing',
  async run(context) {
    const print = (msg: string) => context.print(msg)

    const creds = await loadCredentials()
    if (!creds) {
      print('Not logged in. Run `chkit obsessiondb login` to authenticate.')
      return 1
    }

    const effectiveCreds = { ...creds, base_url: resolveBaseUrl(creds.base_url) }

    const services = await listServices(effectiveCreds)
    const selected = await selectServiceInteractive(services, print)
    if (!selected) return 1

    await saveSelectedService(context.configPath, {
      service_id: selected.id,
      service_name: selected.name,
    })

    print(`Service selected: ${selected.name}`)
    return 0
  },
}
