import process from 'node:process'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { buildRegistry } from '../registry/build.js'
import { parsePackageManager } from '../registry/dependencies.js'
import { applyInstallation, describePlan, planInstallation } from '../registry/install.js'
import { readRegistryCatalog, resolveRegistryItem } from '../registry/resolve.js'
import { emitJson } from '../runtime/json-output.js'
import { CLI_VERSION } from '../runtime/version.js'

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  config: { type: 'string' },
  registry: { type: 'string' },
  path: { type: 'string' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'no-install': { type: 'boolean' },
  'package-manager': { type: 'string' },
  output: { type: 'string' },
} as const

export async function cmdRegistry(command: 'add' | 'registry', argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  if (values.help) {
    console.log(registryHelp(command))
    return
  }
  const action = command === 'add' ? 'add' : positionals.shift()
  const allowed: Record<string, string[]> = {
    add: ['json', 'config', 'registry', 'path', 'dry-run', 'yes', 'no-install', 'package-manager'],
    list: ['json', 'registry'], inspect: ['json', 'registry'], build: ['json', 'output'],
  }
  if (!action || !allowed[action]) throw new Error('Usage: chkit registry <list|inspect|build> [options]')
  for (const name of Object.keys(values)) {
    if (!allowed[action]?.includes(name)) throw new Error(`--${name} is not supported by ${command} ${action === 'add' ? '' : action}`)
  }
  if (action === 'add') {
    const reference = onePositional(positionals, 'chkit add <template>')
    const { item, origin } = await resolveRegistryItem(reference, values.registry)
    const plan = await planInstallation({
      cwd: process.cwd(), item, origin, cliVersion: CLI_VERSION,
      path: values.path, configPath: values.config, noInstall: values['no-install'],
      packageManager: values['package-manager'] ? parsePackageManager(values['package-manager']) : undefined,
    })
    if (!values['dry-run']) await applyInstallation(plan)
    if (values.json) emitJson('add', { ok: true, dryRun: values['dry-run'] ?? false, ...describePlan(plan) })
    else {
      console.log(`${values['dry-run'] ? 'Planned' : plan.alreadyInstalled ? 'Already installed' : 'Added'} ${item.title} (${item.meta.chkit.version})`)
      for (const file of describePlan(plan).files) console.log(`  ${file.action}: ${file.path}`)
      if (plan.dependencies.length > 0) console.log(`  Dependencies: ${plan.dependencies.join(', ')}`)
      if (!values['dry-run']) {
        if (plan.noInstall) console.log(`\nInstall dependencies: ${plan.packageManager} install`)
        console.log(`\nRead ${values.path ?? item.meta.chkit.root}/README.md for credentials, schema migrations, and ingestion.`)
        if (item.meta.chkit.documentation) console.log(`Integration guide: ${item.meta.chkit.documentation}`)
        console.log('No database changes or ingestion were run.')
      }
    }
    return
  }
  if (action === 'list') {
    if (positionals.length > 0) throw new Error('Usage: chkit registry list [--registry <location>]')
    const catalog = await readRegistryCatalog(values.registry)
    const items = catalog.items.map((item) => ({
      name: item.name, title: item.title, description: item.description, version: item.meta.chkit.version,
      resourceCount: item.meta.chkit.resources.length,
      resources: item.meta.chkit.resources,
      strategies: [...new Set(item.meta.chkit.resources.map((resource) => resource.strategy))],
      documentation: item.meta.chkit.documentation,
      logo: item.meta.chkit.logo,
    }))
    if (values.json) emitJson('registry', { ok: true, action, items })
    else {
      console.log(`Apps in ${catalog.name} (${items.length}):`)
      for (const item of items) {
        console.log(`\n${item.title} (${item.name}@${item.version})\n  ${item.description}`)
        console.log(`  ${item.resourceCount} resource${item.resourceCount === 1 ? '' : 's'}; sync strategies: ${item.strategies.join(', ')}`)
        if (item.documentation) console.log(`  Guide: ${item.documentation}`)
        console.log(`  Install: ${installCommand(`${item.name}@${item.version}`, values.registry)}`)
      }
      if (items.length > 0) console.log('\nRun chkit registry inspect <template> for records, scopes, environment, and files. Use the same --registry when browsing a custom catalog.')
    }
    return
  }
  if (action === 'inspect') {
    const reference = onePositional(positionals, 'chkit registry inspect <template>')
    const { item, origin } = await resolveRegistryItem(reference, values.registry)
    if (values.json) emitJson('registry', { ok: true, action, origin, item })
    else {
      console.log(`${item.title} (${item.meta.chkit.version})\n${item.description}\n`)
      if (item.meta.chkit.documentation) console.log(`Guide: ${item.meta.chkit.documentation}`)
      if (item.meta.chkit.logo) console.log(`Logo: ${item.meta.chkit.logo}`)
      console.log(`Install: ${installCommand(reference, values.registry)}`)
      console.log(`Requires chkit ${item.meta.chkit.chkit}; ingestion ${item.meta.chkit.ingest}; ClickHouse ${item.meta.chkit.clickhouse}`)
      console.log(`\nDependencies: ${item.dependencies.join(', ')}`)
      console.log('\nEnvironment (.env.example defaults):')
      const environment = Object.entries(item.meta.chkit.env)
      if (environment.length === 0) console.log('  None declared')
      for (const [name, value] of environment) console.log(`  ${name}: ${value === '' ? 'empty placeholder; configure before syncing' : JSON.stringify(value)}`)
      console.log('\nResources:')
      for (const resource of item.meta.chkit.resources) {
        console.log(`  ${resource.name}: ${resource.description}`)
        console.log(`    Strategy: ${resource.strategy}; scopes: ${resource.scopes.join(', ') || 'none declared'}`)
      }
      console.log('\nFiles:')
      for (const file of item.files) console.log(`  ${file.target}`)
    }
    return
  }
  if (positionals.length > 1) throw new Error('Usage: chkit registry build [manifest] [--output <directory>]')
  const result = await buildRegistry({ manifestPath: resolve(positionals[0] ?? 'registry/registry.json'), outputDir: resolve(values.output ?? 'public/r') })
  const output = { ok: true, action, items: result.items.map((item) => `${item.name}@${item.meta.chkit.version}`), files: result.files }
  if (values.json) emitJson('registry', output)
  else console.log(`Built ${result.items.length} template(s) into ${resolve(values.output ?? 'public/r')}`)
}

function onePositional(positionals: string[], usage: string): string {
  const reference = positionals[0]
  if (!reference || positionals.length !== 1) throw new Error(`Usage: ${usage}`)
  return reference
}

function installCommand(reference: string, registry: string | undefined): string {
  return `chkit add ${shellArgument(reference)}${registry ? ` --registry ${shellArgument(registry)}` : ''}`
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_@./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

function registryHelp(command: 'add' | 'registry'): string {
  if (command === 'registry') return `chkit registry <command> [options]

  list                       Browse apps, sync resources, and integration guides
  inspect <template>         Show records, scopes, environment, files, and install command
  build [manifest]           Build a registry/registry.json manifest

Options:
  --registry <location>      Catalog URL, directory, or local catalog (list/inspect)
  --output <directory>       Build output directory (default: public/r)
  --json                     Machine-readable output
  -h, --help                 Show help

Get started:
  chkit registry list
  chkit registry inspect attio
  chkit add attio

App registry and integration guides: https://chkit.obsessiondb.com/integrations/
`
  return `chkit add <name[@version]|URL|local.json> [options]

Copy an editable template and register its schemas and ingestion pipeline.
Browse apps with chkit registry list; review sync coverage with chkit registry inspect <template>.

  --registry <location>      Catalog URL, directory, or local catalog
  --path <directory>         Provider directory relative to the project
  --config <path>            Project config (default: clickhouse.config.ts)
  --dry-run                  Show the installation plan without writing files
  --no-install               Write files without running the package manager
  --package-manager <name>   bun, npm, pnpm, or yarn
  -y, --yes                  Use defaults; never overwrite conflicting files
  --json                     Machine-readable output
  -h, --help                 Show help
`
}
