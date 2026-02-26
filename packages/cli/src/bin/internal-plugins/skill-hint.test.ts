import { describe, expect, spyOn, test } from 'bun:test'

import type { ChxOnCompleteContext, ChxOnInitContext } from '../../plugins.js'
import { createSkillHintPlugin, HINT_INTERVAL_MS, SKILL_INSTALL_COMMAND, type SkillHintDeps, type SkillHintState } from './skill-hint.js'

function initCtx(overrides?: Partial<ChxOnInitContext>): ChxOnInitContext {
  return { command: 'status', isInteractive: true, jsonMode: false, options: {}, ...overrides }
}

function completeCtx(overrides?: Partial<ChxOnCompleteContext>): ChxOnCompleteContext {
  return { command: 'status', isInteractive: true, jsonMode: false, exitCode: 0, options: {}, ...overrides }
}

function fakeDeps(overrides?: Partial<SkillHintDeps>): Partial<SkillHintDeps> {
  return {
    isSkillInstalled: () => false,
    readState: () => ({}),
    writeState: () => {},
    promptUser: async () => false,
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

    await plugin.hooks!.onInit!(initCtx())
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

    await plugin.hooks!.onInit!(initCtx())

    expect(written).toHaveLength(1)
    expect(written[0]!.lastDismissed).toBeDefined()

    const spy = spyOn(console, 'error').mockImplementation(() => {})
    await plugin.hooks!.onComplete!(completeCtx())
    const output = spy.mock.calls.flat().join(' ')
    expect(output).toContain(SKILL_INSTALL_COMMAND)
    spy.mockRestore()
  })

  test('does not prompt again after recent dismissal', async () => {
    let stateStore: SkillHintState = {}
    let promptCount = 0
    const now = Date.now()

    const makeDeps = (): Partial<SkillHintDeps> => ({
      isSkillInstalled: () => false,
      readState: () => stateStore,
      writeState: (s) => {
        stateStore = s
      },
      promptUser: async () => {
        promptCount++
        return false
      },
      now: () => now,
    })

    // First run — user is prompted and declines
    const plugin1 = createSkillHintPlugin(makeDeps())
    await plugin1.hooks!.onInit!(initCtx())
    expect(promptCount).toBe(1)

    // Second run — state was stored, should not prompt
    const plugin2 = createSkillHintPlugin(makeDeps())
    await plugin2.hooks!.onInit!(initCtx())
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

    await plugin.hooks!.onInit!(initCtx())
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

    await plugin.hooks!.onInit!(initCtx())
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

    await plugin.hooks!.onInit!(initCtx({ isInteractive: false }))
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

    await plugin.hooks!.onInit!(initCtx({ jsonMode: true }))
    expect(prompted).toBe(false)
  })

  test('does not print shutdown message in json mode', async () => {
    const plugin = createSkillHintPlugin(
      fakeDeps({
        promptUser: async () => false,
      })
    )

    await plugin.hooks!.onInit!(initCtx())

    const spy = spyOn(console, 'error').mockImplementation(() => {})
    await plugin.hooks!.onComplete!(completeCtx({ jsonMode: true }))
    expect(spy.mock.calls).toHaveLength(0)
    spy.mockRestore()
  })

  test('does not print shutdown message on command failure', async () => {
    const plugin = createSkillHintPlugin(
      fakeDeps({
        promptUser: async () => false,
      })
    )

    await plugin.hooks!.onInit!(initCtx())

    const spy = spyOn(console, 'error').mockImplementation(() => {})
    await plugin.hooks!.onComplete!(completeCtx({ exitCode: 1 }))
    expect(spy.mock.calls).toHaveLength(0)
    spy.mockRestore()
  })
})
