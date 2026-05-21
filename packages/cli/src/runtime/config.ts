import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  resolveConfig,
  SYNTHESIZED_CONFIG_PATH,
  type ChxConfig,
  type ChxConfigEnv,
  type ChxConfigFn,
  type ChxConfigInput,
  type ChxPluginRegistration,
  type ChxUserConfig,
  type ResolvedChxConfig,
} from '@chkit/core'

import { mergeUserConfig } from './config-merge.js'
import { debug } from './debug.js'
import {
  getUserConfigDir,
  USER_CREDENTIALS_FILE,
  USER_PROFILE_CONFIG_FILE,
} from './user-config.js'

export const DEFAULT_CONFIG_FILE = 'clickhouse.config.ts'

export type ConfigSource = 'project' | 'profile' | 'synthesized'

export interface LoadedConfig {
  config: ResolvedChxConfig
  path: string
  source: ConfigSource
  profileLayered: boolean
}

interface RawConfig {
  raw: ChxUserConfig
  path: string
}

interface ProfileLayer extends RawConfig {
  source: 'profile' | 'synthesized'
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

  const projectPath = configPathArg
    ? resolve(cwd, configPathArg)
    : resolve(cwd, DEFAULT_CONFIG_FILE)

  if (configPathArg) {
    debug('config', `resolving explicit config at ${projectPath}`)
    if (!existsSync(projectPath)) {
      throw new Error(`Config not found at ${projectPath}.`)
    }
  } else {
    debug('config', `looking for project config at ${projectPath}`)
  }

  const projectExists = existsSync(projectPath)

  if (projectExists) {
    const project = await readRawConfig(projectPath, env)
    const layer = await readProfileLayer(userDir, env, options.allowSynthesizedProfileConfig)
    if (layer) {
      debug('config', `layering profile (${layer.source}, path=${layer.path}) under project`)
      const merged = mergeUserConfig(layer.raw, project.raw)
      return finalize(merged, project.path, 'project', true)
    }
    return finalize(project.raw, project.path, 'project', false)
  }

  const layer = await readProfileLayer(userDir, env, options.allowSynthesizedProfileConfig)
  if (layer) {
    return finalize(layer.raw, layer.path, layer.source, false)
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

async function readRawConfig(configPath: string, env: ChxConfigEnv): Promise<RawConfig> {
  const mod = await import(pathToFileURL(configPath).href)
  const candidate = (mod.default ?? mod.config) as ChxConfigInput | undefined
  if (!candidate) {
    throw new Error(
      `Config file ${configPath} must export a default/config object or a function via defineConfig.`,
    )
  }

  const isFn = isConfigFunction(candidate)
  debug('config', `config export is ${isFn ? 'function' : 'object'} (path=${configPath})`)
  const raw = isFn ? await candidate(env) : (candidate as ChxConfig)
  return { raw, path: configPath }
}

async function readProfileLayer(
  userDir: string,
  env: ChxConfigEnv,
  allowSynthesized: boolean | undefined,
): Promise<ProfileLayer | null> {
  const profilePath = resolve(userDir, USER_PROFILE_CONFIG_FILE)
  if (existsSync(profilePath)) {
    debug('config', `found profile config at ${profilePath}`)
    const { raw } = await readRawConfig(profilePath, env)
    return { raw, path: profilePath, source: 'profile' }
  }

  const credentialsPath = resolve(userDir, USER_CREDENTIALS_FILE)
  if (existsSync(credentialsPath)) {
    debug('config', `synthesizing profile layer from credentials at ${credentialsPath}`)
    return synthesizedProfileLayer()
  }

  if (allowSynthesized) {
    debug('config', 'synthesizing profile layer without existing credentials')
    return synthesizedProfileLayer()
  }

  return null
}

function finalize(
  raw: ChxUserConfig,
  path: string,
  source: ConfigSource,
  profileLayered: boolean,
): LoadedConfig {
  const config = resolveConfig(raw)
  debug('config', `loaded (source=${source}, profileLayered=${profileLayered})`, {
    schema: config.schema,
    outDir: config.outDir,
    migrationsDir: config.migrationsDir,
    clickhouse: config.clickhouse
      ? `${config.clickhouse.url} (db: ${config.clickhouse.database ?? 'default'})`
      : 'not configured',
    plugins: (config.plugins ?? []).length,
  })
  return { config, path, source, profileLayered }
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

async function synthesizedProfileLayer(): Promise<ProfileLayer> {
  const raw: ChxUserConfig = {
    schema: [],
    plugins: [await loadObsessionDBRegistration()],
  }
  return { raw, path: SYNTHESIZED_CONFIG_PATH, source: 'synthesized' }
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
