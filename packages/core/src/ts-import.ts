import { pathToFileURL } from 'node:url'

type ModuleNamespace = Record<string, unknown>
type ModuleImporter = (id: string) => Promise<ModuleNamespace>

let cachedNodeImporter: ModuleImporter | null = null

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

async function getNodeImporter(): Promise<ModuleImporter> {
  if (cachedNodeImporter) return cachedNodeImporter
  const { createJiti } = await import('jiti')
  const jiti = createJiti(import.meta.url)
  cachedNodeImporter = (id) => jiti.import(id) as Promise<ModuleNamespace>
  return cachedNodeImporter
}

/**
 * Import a user config or schema module by absolute path.
 *
 * Bun transpiles TypeScript natively, so it uses a plain dynamic import. Under
 * Node, `.ts` files are loaded through jiti so they work without a separate
 * build step — matching the documented "Node.js 20+" support. Plain `.js`/`.mjs`
 * modules load the same way under either runtime.
 */
export async function importModuleFile(absolutePath: string): Promise<ModuleNamespace> {
  if (isBun()) {
    return (await import(pathToFileURL(absolutePath).href)) as ModuleNamespace
  }
  const nodeImport = await getNodeImporter()
  return nodeImport(absolutePath)
}
