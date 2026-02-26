import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { definePlugin, type ChxPlugin } from '../../plugins.js'

export const SKILL_INSTALL_COMMAND = 'npx skills add obsessiondb/chkit'
export const HINT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface SkillHintState {
  lastDismissed?: string
}

export interface SkillHintDeps {
  isSkillInstalled(): boolean
  readState(): SkillHintState
  writeState(state: SkillHintState): void
  promptUser(): Promise<boolean>
  installSkill(): Promise<boolean>
  now(): number
}

function getStateDir(): string {
  return join(homedir(), '.chkit')
}

function getStateFilePath(): string {
  return join(getStateDir(), 'skill-hint.json')
}

const defaultDeps: SkillHintDeps = {
  isSkillInstalled() {
    const cwd = process.cwd()
    const projectSkill = join(cwd, '.claude', 'skills', 'chkit', 'SKILL.md')
    const globalSkill = join(homedir(), '.claude', 'skills', 'chkit', 'SKILL.md')
    return existsSync(projectSkill) || existsSync(globalSkill)
  },

  readState(): SkillHintState {
    try {
      return JSON.parse(readFileSync(getStateFilePath(), 'utf-8')) as SkillHintState
    } catch {
      return {}
    }
  },

  writeState(state: SkillHintState): void {
    const dir = getStateDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(getStateFilePath(), JSON.stringify(state, null, 2) + '\n')
  },

  async promptUser(): Promise<boolean> {
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      console.error('')
      console.error('chkit has an AI agent skill for Claude Code.')
      console.error(`Install it with: ${SKILL_INSTALL_COMMAND}`)
      console.error('')
      const answer = await rl.question('Install now? [y/N] ')
      return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
    } finally {
      rl.close()
    }
  },

  async installSkill(): Promise<boolean> {
    const { execSync } = await import('node:child_process')
    try {
      console.error('')
      execSync(SKILL_INSTALL_COMMAND, { stdio: 'inherit' })
      return true
    } catch {
      console.error(`Failed to install. Run manually: ${SKILL_INSTALL_COMMAND}`)
      return false
    }
  },

  now: () => Date.now(),
}

export function createSkillHintPlugin(overrides?: Partial<SkillHintDeps>): ChxPlugin {
  const deps: SkillHintDeps = { ...defaultDeps, ...overrides }
  let pendingMessage: string | undefined

  return definePlugin({
    manifest: {
      name: '@chkit/internal-skill-hint',
      apiVersion: 1,
    },
    hooks: {
      async onInit(ctx) {
        if (!ctx.isInteractive || ctx.jsonMode) return
        if (deps.isSkillInstalled()) return

        const state = deps.readState()
        if (state.lastDismissed) {
          const elapsed = deps.now() - new Date(state.lastDismissed).getTime()
          if (elapsed < HINT_INTERVAL_MS) return
        }

        const accepted = await deps.promptUser()
        if (accepted) {
          await deps.installSkill()
        } else {
          deps.writeState({ lastDismissed: new Date(deps.now()).toISOString() })
          pendingMessage = `You can install it later with: ${SKILL_INSTALL_COMMAND}`
        }
      },

      onComplete(ctx) {
        if (pendingMessage && !ctx.jsonMode && ctx.exitCode === 0) {
          console.error('')
          console.error(pendingMessage)
        }
      },
    },
  })
}
