import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

import { definePlugin, type ChxPlugin } from '../../plugins.js'

export type AgentKind = 'claude' | 'cursor' | 'copilot' | 'windsurf' | 'roo' | 'augment' | 'continue' | 'trae' | 'unknown'

interface AgentInfo { name: string; skillsDir: string }

export const AGENT_REGISTRY: Record<Exclude<AgentKind, 'unknown'>, AgentInfo> = {
  claude:   { name: 'Claude Code', skillsDir: '.claude/skills' },
  cursor:   { name: 'Cursor',      skillsDir: '.agents/skills' },
  copilot:  { name: 'Copilot',     skillsDir: '.agents/skills' },
  windsurf: { name: 'Windsurf',    skillsDir: '.windsurf/skills' },
  roo:      { name: 'Roo Code',    skillsDir: '.roo/skills' },
  augment:  { name: 'Augment',     skillsDir: '.augment/skills' },
  continue: { name: 'Continue',    skillsDir: '.continue/skills' },
  trae:     { name: 'Trae',        skillsDir: '.trae/skills' },
}

const AGENT_MARKERS: { path: string; agent: AgentKind }[] = [
  { path: '.claude', agent: 'claude' },
  { path: 'CLAUDE.md', agent: 'claude' },
  { path: '.cursor', agent: 'cursor' },
  { path: '.cursorrules', agent: 'cursor' },
  { path: '.github/copilot-instructions.md', agent: 'copilot' },
  { path: '.windsurf', agent: 'windsurf' },
  { path: '.roo', agent: 'roo' },
  { path: '.augment', agent: 'augment' },
  { path: '.continue', agent: 'continue' },
  { path: '.trae', agent: 'trae' },
]

export interface AgentRootResult { root: string; agent: AgentKind }

/**
 * Walk up from `cwd` to find the best directory for installing agent skills.
 *
 * 1. Look for agentic markers (.claude/, .cursor/, CLAUDE.md, etc.)
 * 2. Fall back to the git root (.git)
 * 3. Fall back to `cwd`
 */
export function findAgentRoot(cwd: string): AgentRootResult {
  // Pass 1: look for agentic markers
  let dir = cwd
  while (true) {
    for (const marker of AGENT_MARKERS) {
      if (existsSync(join(dir, marker.path))) return { root: dir, agent: marker.agent }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Pass 2: look for .git
  dir = cwd
  while (true) {
    if (existsSync(join(dir, '.git'))) return { root: dir, agent: 'unknown' }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return { root: cwd, agent: 'unknown' }
}

export const SKILL_INSTALL_COMMAND = 'npx skills add obsessiondb/chkit'
export const HINT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface SkillHintState {
  lastDismissed?: string
}

export interface SkillHintDeps {
  detectAgent(): AgentRootResult
  isSkillInstalled(): boolean
  readState(): SkillHintState
  writeState(state: SkillHintState): void
  promptUser(agent: AgentKind): Promise<boolean>
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
  detectAgent() {
    return findAgentRoot(process.cwd())
  },

  isSkillInstalled() {
    const { root, agent } = findAgentRoot(process.cwd())
    // Check agent-specific skill path
    if (agent !== 'unknown') {
      const { skillsDir } = AGENT_REGISTRY[agent]
      if (existsSync(join(root, skillsDir, 'chkit', 'SKILL.md'))) return true
    }
    // Check universal .agents/skills path
    if (existsSync(join(root, '.agents', 'skills', 'chkit', 'SKILL.md'))) return true
    // Check global Claude path
    if (existsSync(join(homedir(), '.claude', 'skills', 'chkit', 'SKILL.md'))) return true
    return false
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
    writeFileSync(getStateFilePath(), `${JSON.stringify(state, null, 2)}\n`)
  },

  async promptUser(agent: AgentKind): Promise<boolean> {
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const agentLabel = agent !== 'unknown' ? AGENT_REGISTRY[agent].name : undefined
      console.error('')
      console.error(agentLabel
        ? `chkit has an AI agent skill for ${agentLabel}.`
        : 'chkit has an AI agent skill available.')
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
      execSync(SKILL_INSTALL_COMMAND, { cwd: findAgentRoot(process.cwd()).root, stdio: 'inherit' })
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

        const { agent } = deps.detectAgent()
        const accepted = await deps.promptUser(agent)
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
