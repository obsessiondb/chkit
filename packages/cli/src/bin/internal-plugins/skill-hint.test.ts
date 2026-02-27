import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import type { ChxOnCompleteContext, ChxOnInitContext } from '../../plugins.js'
import { createSkillHintPlugin, findAgentRoot, HINT_INTERVAL_MS, SKILL_INSTALL_COMMAND, type AgentKind, type SkillHintDeps, type SkillHintState } from './skill-hint.js'

function initCtx(overrides?: Partial<ChxOnInitContext>): ChxOnInitContext {
  return { command: 'status', isInteractive: true, jsonMode: false, options: {}, ...overrides }
}

function completeCtx(overrides?: Partial<ChxOnCompleteContext>): ChxOnCompleteContext {
  return { command: 'status', isInteractive: true, jsonMode: false, exitCode: 0, options: {}, ...overrides }
}

function fakeDeps(overrides?: Partial<SkillHintDeps>): Partial<SkillHintDeps> {
  return {
    detectAgent: () => ({ root: '/fake', agent: 'claude' }),
    isSkillInstalled: () => false,
    readState: () => ({}),
    writeState: () => {},
    promptUser: async (_agent: AgentKind) => false,
    installSkill: async () => true,
    now: () => Date.now(),
    ...overrides,
  }
}

describe('skill-hint plugin', () => {
  test('installs skill when user accepts', async () => {
    let installed = false
    const plugin = createSkillHintPlugin(
      fakeDeps({
        promptUser: async () => true,
        installSkill: async () => {
          installed = true
          return true
        },
      })
    )

    await plugin.hooks?.onInit?.(initCtx())
    expect(installed).toBe(true)
  })

  test('prints install command at end when user declines', async () => {
    const written: SkillHintState[] = []
    const plugin = createSkillHintPlugin(
      fakeDeps({
        promptUser: async () => false,
        writeState: (s) => written.push(s),
      })
    )

    await plugin.hooks?.onInit?.(initCtx())

    expect(written).toHaveLength(1)
    expect(written[0]?.lastDismissed).toBeDefined()

    const spy = spyOn(console, 'error').mockImplementation(() => {})
    await plugin.hooks?.onComplete?.(completeCtx())
    const output = spy.mock.calls.flat().join(' ')
    expect(output).toContain(SKILL_INSTALL_COMMAND)
    spy.mockRestore()
  })

  test('does not prompt again after recent dismissal', async () => {
    let stateStore: SkillHintState = {}
    let promptCount = 0
    const now = Date.now()

    const makeDeps = (): Partial<SkillHintDeps> => ({
      detectAgent: () => ({ root: '/fake', agent: 'claude' }),
      isSkillInstalled: () => false,
      readState: () => stateStore,
      writeState: (s) => {
        stateStore = s
      },
      promptUser: async (_agent: AgentKind) => {
        promptCount++
        return false
      },
      now: () => now,
    })

    // First run — user is prompted and declines
    const plugin1 = createSkillHintPlugin(makeDeps())
    await plugin1.hooks?.onInit?.(initCtx())
    expect(promptCount).toBe(1)

    // Second run — state was stored, should not prompt
    const plugin2 = createSkillHintPlugin(makeDeps())
    await plugin2.hooks?.onInit?.(initCtx())
    expect(promptCount).toBe(1)
  })

  test('prompts again after 30 days', async () => {
    let promptCount = 0
    const now = Date.now()
    const thirtyOneDaysAgo = now - HINT_INTERVAL_MS - 1

    const plugin = createSkillHintPlugin(
      fakeDeps({
        readState: () => ({ lastDismissed: new Date(thirtyOneDaysAgo).toISOString() }),
        promptUser: async () => {
          promptCount++
          return false
        },
        now: () => now,
      })
    )

    await plugin.hooks?.onInit?.(initCtx())
    expect(promptCount).toBe(1)
  })

  test('skips prompt when skill is already installed', async () => {
    let prompted = false
    const plugin = createSkillHintPlugin(
      fakeDeps({
        isSkillInstalled: () => true,
        promptUser: async () => {
          prompted = true
          return false
        },
      })
    )

    await plugin.hooks?.onInit?.(initCtx())
    expect(prompted).toBe(false)
  })

  test('skips prompt in non-interactive mode', async () => {
    let prompted = false
    const plugin = createSkillHintPlugin(
      fakeDeps({
        promptUser: async () => {
          prompted = true
          return false
        },
      })
    )

    await plugin.hooks?.onInit?.(initCtx({ isInteractive: false }))
    expect(prompted).toBe(false)
  })

  test('skips prompt in json mode', async () => {
    let prompted = false
    const plugin = createSkillHintPlugin(
      fakeDeps({
        promptUser: async () => {
          prompted = true
          return false
        },
      })
    )

    await plugin.hooks?.onInit?.(initCtx({ jsonMode: true }))
    expect(prompted).toBe(false)
  })

  test('does not print shutdown message in json mode', async () => {
    const plugin = createSkillHintPlugin(
      fakeDeps({
        promptUser: async () => false,
      })
    )

    await plugin.hooks?.onInit?.(initCtx())

    const spy = spyOn(console, 'error').mockImplementation(() => {})
    await plugin.hooks?.onComplete?.(completeCtx({ jsonMode: true }))
    expect(spy.mock.calls).toHaveLength(0)
    spy.mockRestore()
  })

  test('does not print shutdown message on command failure', async () => {
    const plugin = createSkillHintPlugin(
      fakeDeps({
        promptUser: async () => false,
      })
    )

    await plugin.hooks?.onInit?.(initCtx())

    const spy = spyOn(console, 'error').mockImplementation(() => {})
    await plugin.hooks?.onComplete?.(completeCtx({ exitCode: 1 }))
    expect(spy.mock.calls).toHaveLength(0)
    spy.mockRestore()
  })
})

describe('findAgentRoot', () => {
  const base = join(tmpdir(), `chkit-test-${Date.now()}`)

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  function makeDir(...segments: string[]): string {
    const dir = join(base, ...segments)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  test('returns cwd when .claude/ exists in cwd', () => {
    const root = makeDir('project')
    mkdirSync(join(root, '.claude'), { recursive: true })
    expect(findAgentRoot(root)).toEqual({ root, agent: 'claude' })
  })

  test('returns parent when .claude/ exists in parent but not cwd', () => {
    const root = makeDir('monorepo')
    mkdirSync(join(root, '.claude'), { recursive: true })
    const sub = makeDir('monorepo', 'packages', 'backend')
    expect(findAgentRoot(sub)).toEqual({ root, agent: 'claude' })
  })

  test('finds CLAUDE.md as agentic marker', () => {
    const root = makeDir('project')
    writeFileSync(join(root, 'CLAUDE.md'), '')
    const sub = makeDir('project', 'src')
    expect(findAgentRoot(sub)).toEqual({ root, agent: 'claude' })
  })

  test('finds .cursorrules as agentic marker', () => {
    const root = makeDir('project')
    writeFileSync(join(root, '.cursorrules'), '')
    const sub = makeDir('project', 'src')
    expect(findAgentRoot(sub)).toEqual({ root, agent: 'cursor' })
  })

  test('finds .github/copilot-instructions.md as agentic marker', () => {
    const root = makeDir('project')
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, '.github', 'copilot-instructions.md'), '')
    const sub = makeDir('project', 'src')
    expect(findAgentRoot(sub)).toEqual({ root, agent: 'copilot' })
  })

  test('finds .cursor/ as agentic marker', () => {
    const root = makeDir('project-cursor')
    mkdirSync(join(root, '.cursor'), { recursive: true })
    const sub = makeDir('project-cursor', 'src')
    expect(findAgentRoot(sub)).toEqual({ root, agent: 'cursor' })
  })

  test('finds .windsurf/ as agentic marker', () => {
    const root = makeDir('project-windsurf')
    mkdirSync(join(root, '.windsurf'), { recursive: true })
    const sub = makeDir('project-windsurf', 'src')
    expect(findAgentRoot(sub)).toEqual({ root, agent: 'windsurf' })
  })

  test('finds .roo/ as agentic marker', () => {
    const root = makeDir('project-roo')
    mkdirSync(join(root, '.roo'), { recursive: true })
    const sub = makeDir('project-roo', 'src')
    expect(findAgentRoot(sub)).toEqual({ root, agent: 'roo' })
  })

  test('falls back to git root when no agentic markers found', () => {
    const root = makeDir('repo')
    mkdirSync(join(root, '.git'), { recursive: true })
    const sub = makeDir('repo', 'packages', 'backend')
    expect(findAgentRoot(sub)).toEqual({ root, agent: 'unknown' })
  })

  test('prefers agentic marker over git root', () => {
    const gitRoot = makeDir('repo')
    mkdirSync(join(gitRoot, '.git'), { recursive: true })
    const agentRoot = makeDir('repo', 'packages', 'app')
    mkdirSync(join(agentRoot, '.claude'), { recursive: true })
    const sub = makeDir('repo', 'packages', 'app', 'src')
    expect(findAgentRoot(sub)).toEqual({ root: agentRoot, agent: 'claude' })
  })

  test('returns cwd when no markers found at all', () => {
    const dir = makeDir('bare', 'nested')
    expect(findAgentRoot(dir)).toEqual({ root: dir, agent: 'unknown' })
  })
})

describe('agent-aware prompting', () => {
  test('passes detected agent to promptUser', async () => {
    let receivedAgent: AgentKind | undefined
    const plugin = createSkillHintPlugin(
      fakeDeps({
        detectAgent: () => ({ root: '/fake', agent: 'windsurf' }),
        promptUser: async (agent: AgentKind) => {
          receivedAgent = agent
          return false
        },
      })
    )

    await plugin.hooks?.onInit?.(initCtx())
    expect(receivedAgent).toBe('windsurf')
  })

  test('passes unknown agent when no markers found', async () => {
    let receivedAgent: AgentKind | undefined
    const plugin = createSkillHintPlugin(
      fakeDeps({
        detectAgent: () => ({ root: '/fake', agent: 'unknown' }),
        promptUser: async (agent: AgentKind) => {
          receivedAgent = agent
          return false
        },
      })
    )

    await plugin.hooks?.onInit?.(initCtx())
    expect(receivedAgent).toBe('unknown')
  })

  test('passes different agent kinds correctly', async () => {
    const agents: AgentKind[] = ['claude', 'cursor', 'copilot', 'roo', 'trae']
    for (const expected of agents) {
      let receivedAgent: AgentKind | undefined
      const plugin = createSkillHintPlugin(
        fakeDeps({
          detectAgent: () => ({ root: '/fake', agent: expected }),
          promptUser: async (agent: AgentKind) => {
            receivedAgent = agent
            return false
          },
        })
      )

      await plugin.hooks?.onInit?.(initCtx())
      expect(receivedAgent).toBe(expected)
    }
  })
})
