import process from 'node:process'

import { definePlugin, type ChxPlugin } from '../../plugins.js'

import {
  findAgentRoot,
  isSkillInstalledAt,
  type AgentKind,
  type AgentRootResult,
} from './agent-detect.js'
import {
  installSkill as defaultInstallSkill,
  promptInstall as defaultPromptInstall,
  SKILL_INSTALL_COMMAND,
} from './prompt.js'
import {
  HINT_INTERVAL_MS,
  readSkillHintState,
  writeSkillHintState,
  type SkillHintState,
} from './state.js'

export {
  findAgentRoot,
  HINT_INTERVAL_MS,
  SKILL_INSTALL_COMMAND,
  type AgentKind,
  type SkillHintState,
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

const defaultDeps: SkillHintDeps = {
  detectAgent() {
    return findAgentRoot(process.cwd())
  },
  isSkillInstalled() {
    const { root, agent } = findAgentRoot(process.cwd())
    return isSkillInstalledAt(root, agent)
  },
  readState: readSkillHintState,
  writeState: writeSkillHintState,
  promptUser: defaultPromptInstall,
  installSkill: defaultInstallSkill,
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
