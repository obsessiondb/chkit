import process from 'node:process'
import * as Effect from 'effect/Effect'
import { fromPromise, runEffect } from '../../runtime/effect.js'

import { AGENT_REGISTRY, findAgentRoot, type AgentKind } from './agent-detect.js'

export const SKILL_INSTALL_COMMAND = 'npx skills add obsessiondb/chkit'

export async function promptInstall(agent: AgentKind): Promise<boolean> {
  return runEffect(
    Effect.gen(function* () {
      const { createInterface } = yield* fromPromise(() => import('node:readline/promises'))
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => createInterface({ input: process.stdin, output: process.stderr })),
        (rl) =>
          Effect.exit(
            Effect.gen(function* () {
              const agentLabel = agent !== 'unknown' ? AGENT_REGISTRY[agent].name : undefined
              console.error('')
              console.error(
                agentLabel
                  ? `chkit has an AI agent skill for ${agentLabel}.`
                  : 'chkit has an AI agent skill available.',
              )
              console.error(`Install it with: ${SKILL_INSTALL_COMMAND}`)
              console.error('')
              const answer = yield* fromPromise(() => rl.question('Install now? [y/N] '))
              return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
            }),
          ),
        (rl) => Effect.sync(() => rl.close()),
      ).pipe(Effect.flatten)
    }),
  )
}

export async function installSkill(): Promise<boolean> {
  return runEffect(
    Effect.gen(function* () {
      const { execSync } = yield* fromPromise(() => import('node:child_process'))
      return yield* Effect.try({
        try: () => {
          console.error('')
          execSync(SKILL_INSTALL_COMMAND, {
            cwd: findAgentRoot(process.cwd()).root,
            stdio: 'inherit',
          })
          return true
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            console.error(`Failed to install. Run manually: ${SKILL_INSTALL_COMMAND}`)
            return false
          }),
        ),
      )
    }),
  )
}
