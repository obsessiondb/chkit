import { realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

type ModuleNamespace = Record<string, unknown>
type ModuleImporter = (id: string) => Promise<ModuleNamespace>

let cachedNodeImporter: ModuleImporter | null = null

// Bun never settles a second import() of a file that failed to parse, even after
// the file is fixed, and a second import() of a module whose evaluation threw
// resolves to the half-evaluated module. Each failure is kept and thrown again,
// so importing the same file twice in one process fails the same way. Bun knows
// a module by its real path, so the import and the kept failure use it too: a
// path through a symlink (such as /tmp on macOS) is the same file.
const failedBunImports = new Map<string, unknown>()

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
  if (isBun()) return importWithBun(absolutePath)
  const nodeImport = await getNodeImporter()
  return nodeImport(absolutePath)
}

async function importWithBun(absolutePath: string): Promise<ModuleNamespace> {
  // A path that does not resolve is imported as given, so the import reports it.
  const href = pathToFileURL(await realpath(absolutePath).catch(() => absolutePath)).href
  if (failedBunImports.has(href)) throw failedBunImports.get(href)
  try {
    return (await import(href)) as ModuleNamespace
  } catch (error) {
    failedBunImports.set(href, error)
    throw error
  }
}
