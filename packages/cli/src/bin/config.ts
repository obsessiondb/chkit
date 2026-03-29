import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  resolveConfig,
  type ChxConfig,
  type ChxConfigEnv,
  type ChxConfigFn,
  type ChxConfigInput,
  type ResolvedChxConfig,
} from '@chkit/core'
import { debug } from './debug.js'

export const DEFAULT_CONFIG_FILE = 'clickhouse.config.ts'

function isConfigFunction(candidate: ChxConfigInput): candidate is ChxConfigFn {
  return typeof candidate === 'function'
}

export async function loadConfig(
  configPathArg?: string,
  env: ChxConfigEnv = {}
): Promise<{ config: ResolvedChxConfig; path: string }> {
  const configPath = resolve(process.cwd(), configPathArg ?? DEFAULT_CONFIG_FILE)
  debug('config', `resolving config at ${configPath}`)
  if (!existsSync(configPath)) {
    throw new Error(`Config not found at ${configPath}. Run 'chkit init' first.`)
  }

  const mod = await import(pathToFileURL(configPath).href)
  const candidate = (mod.default ?? mod.config) as ChxConfigInput | undefined
  if (!candidate) {
    throw new Error(
      `Config file ${configPath} must export a default/config object or a function via defineConfig.`
    )
  }

  const isFn = isConfigFunction(candidate)
  debug('config', `config export is ${isFn ? 'function' : 'object'}`)
  const userConfig = isFn ? await candidate(env) : (candidate as ChxConfig)
  const config = resolveConfig(userConfig)

  debug('config', `loaded`, {
    schema: config.schema,
    outDir: config.outDir,
    migrationsDir: config.migrationsDir,
    clickhouse: config.clickhouse ? `${config.clickhouse.url} (db: ${config.clickhouse.database ?? 'default'})` : 'not configured',
    plugins: (config.plugins ?? []).length,
  })

  return { config, path: configPath }
}

export async function writeIfMissing(filePath: string, content: string): Promise<void> {
  if (existsSync(filePath)) return
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

export function resolveDirs(config: ResolvedChxConfig): { outDir: string; migrationsDir: string; metaDir: string } {
  const outDir = resolve(process.cwd(), config.outDir)
  const migrationsDir = resolve(process.cwd(), config.migrationsDir)
  const metaDir = resolve(process.cwd(), config.metaDir)
  return { outDir, migrationsDir, metaDir }
}
