import process from 'node:process'

import { AGENT_REGISTRY, findAgentRoot, type AgentKind } from './agent-detect.js'

export const SKILL_INSTALL_COMMAND = 'npx skills add obsessiondb/chkit'

export async function promptInstall(agent: AgentKind): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const agentLabel = agent !== 'unknown' ? AGENT_REGISTRY[agent].name : undefined
    console.error('')
    console.error(
      agentLabel
        ? `chkit has an AI agent skill for ${agentLabel}.`
        : 'chkit has an AI agent skill available.',
    )
    console.error(`Install it with: ${SKILL_INSTALL_COMMAND}`)
    console.error('')
    const answer = await rl.question('Install now? [y/N] ')
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

export async function installSkill(): Promise<boolean> {
  const { execSync } = await import('node:child_process')
  try {
    console.error('')
    execSync(SKILL_INSTALL_COMMAND, {
      cwd: findAgentRoot(process.cwd()).root,
      stdio: 'inherit',
    })
    return true
  } catch {
    console.error(`Failed to install. Run manually: ${SKILL_INSTALL_COMMAND}`)
    return false
  }
}
