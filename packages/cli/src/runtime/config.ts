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
  type ChxPluginRegistration,
  type ResolvedChxConfig,
} from '@chkit/core'

import { debug } from './debug.js'
import {
  getUserConfigDir,
  SYNTHESIZED_CONFIG_FILENAME,
  USER_CREDENTIALS_FILE,
  USER_PROFILE_CONFIG_FILE,
} from './user-config.js'

export const DEFAULT_CONFIG_FILE = 'clickhouse.config.ts'

export type ConfigSource = 'project' | 'profile' | 'synthesized'

export interface LoadedConfig {
  config: ResolvedChxConfig
  path: string
  source: ConfigSource
}

function isConfigFunction(candidate: ChxConfigInput): candidate is ChxConfigFn {
  return typeof candidate === 'function'
}

export async function loadConfig(
  configPathArg?: string,
  env: ChxConfigEnv = {},
  options: {
    command?: string
    cwd?: string
    userConfigDir?: string
    allowSynthesizedProfileConfig?: boolean
  } = {},
): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd()
  const userDir = options.userConfigDir ?? getUserConfigDir()

  if (configPathArg) {
    const explicitPath = resolve(cwd, configPathArg)
    debug('config', `resolving explicit config at ${explicitPath}`)
    if (!existsSync(explicitPath)) {
      throw new Error(`Config not found at ${explicitPath}.`)
    }
    return loadFromFile(explicitPath, env, 'project')
  }

  const projectPath = resolve(cwd, DEFAULT_CONFIG_FILE)
  debug('config', `looking for project config at ${projectPath}`)
  if (existsSync(projectPath)) {
    return loadFromFile(projectPath, env, 'project')
  }

  const profilePath = resolve(userDir, USER_PROFILE_CONFIG_FILE)
  debug('config', `looking for user profile config at ${profilePath}`)
  if (existsSync(profilePath)) {
    return loadFromFile(profilePath, env, 'profile')
  }

  const credentialsPath = resolve(userDir, USER_CREDENTIALS_FILE)
  if (existsSync(credentialsPath)) {
    debug('config', `synthesizing query-only config from credentials at ${credentialsPath}`)
    return synthesizeProfileConfig(userDir)
  }

  if (options.allowSynthesizedProfileConfig) {
    debug('config', 'synthesizing profile config without existing credentials')
    return synthesizeProfileConfig(userDir)
  }

  if (options.command === 'query') {
    throw new Error(
      `No project config found at ${projectPath}, and no ObsessionDB profile is available.\n` +
        `Run 'chkit obsessiondb login' to query ObsessionDB from any directory, or run 'chkit init' in a project.`,
    )
  }

  throw new Error(
    `Config not found at ${projectPath}.\n` +
      `Either run 'chkit init' in your project, or run 'chkit obsessiondb login' to use chkit from any directory.`,
  )
}

async function loadFromFile(
  configPath: string,
  env: ChxConfigEnv,
  source: ConfigSource,
): Promise<LoadedConfig> {
  const mod = await import(pathToFileURL(configPath).href)
  const candidate = (mod.default ?? mod.config) as ChxConfigInput | undefined
  if (!candidate) {
    throw new Error(
      `Config file ${configPath} must export a default/config object or a function via defineConfig.`,
    )
  }

  const isFn = isConfigFunction(candidate)
  debug('config', `config export is ${isFn ? 'function' : 'object'}`)
  const userConfig = isFn ? await candidate(env) : (candidate as ChxConfig)
  const config = resolveConfig(userConfig)

  debug('config', `loaded (source=${source})`, {
    schema: config.schema,
    outDir: config.outDir,
    migrationsDir: config.migrationsDir,
    clickhouse: config.clickhouse
      ? `${config.clickhouse.url} (db: ${config.clickhouse.database ?? 'default'})`
      : 'not configured',
    plugins: (config.plugins ?? []).length,
  })

  return { config, path: configPath, source }
}

async function loadObsessionDBRegistration(): Promise<ChxPluginRegistration> {
  try {
    const mod = (await import('@chkit/plugin-obsessiondb')) as {
      obsessiondb?: () => ChxPluginRegistration
    }
    if (typeof mod.obsessiondb !== 'function') {
      throw new Error('missing obsessiondb export')
    }
    return mod.obsessiondb()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `ObsessionDB profile fallback requires @chkit/plugin-obsessiondb, but it could not be loaded: ${message}`,
    )
  }
}

async function synthesizeProfileConfig(userDir: string): Promise<LoadedConfig> {
  const path = resolve(userDir, SYNTHESIZED_CONFIG_FILENAME)
  const config = resolveConfig({
    schema: [],
    plugins: [await loadObsessionDBRegistration()],
  })
  debug('config', `synthesized profile config at virtual path ${path}`)
  return { config, path, source: 'synthesized' }
}

export async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  if (existsSync(filePath)) return false
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
  return true
}

export function resolveDirs(config: ResolvedChxConfig): { outDir: string; migrationsDir: string; metaDir: string } {
  const outDir = resolve(process.cwd(), config.outDir)
  const migrationsDir = resolve(process.cwd(), config.migrationsDir)
  const metaDir = resolve(process.cwd(), config.metaDir)
  return { outDir, migrationsDir, metaDir }
}
