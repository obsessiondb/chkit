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

export const DEFAULT_CONFIG_FILE = 'clickhouse.config.ts'

export interface CommandContext {
  config: ResolvedChxConfig
  configPath: string
  dirs: { outDir: string; migrationsDir: string; metaDir: string }
  jsonMode: boolean
}

export function parseArg(flag: string, args: string[]): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  return args[idx + 1]
}

export function hasFlag(flag: string, args: string[]): boolean {
  return args.includes(flag)
}

function isConfigFunction(candidate: ChxConfigInput): candidate is ChxConfigFn {
  return typeof candidate === 'function'
}

export async function loadConfig(
  configPathArg?: string,
  env: ChxConfigEnv = {}
): Promise<{ config: ResolvedChxConfig; path: string }> {
  const configPath = resolve(process.cwd(), configPathArg ?? DEFAULT_CONFIG_FILE)
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

  const userConfig = isConfigFunction(candidate) ? await candidate(env) : (candidate as ChxConfig)

  return {
    config: resolveConfig(userConfig),
    path: configPath,
  }
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

export async function getCommandContext(args: string[]): Promise<CommandContext> {
  const configPath = parseArg('--config', args)
  const jsonMode = hasFlag('--json', args)
  const loaded = await loadConfig(configPath)
  return {
    config: loaded.config,
    configPath: loaded.path,
    dirs: resolveDirs(loaded.config),
    jsonMode,
  }
}
