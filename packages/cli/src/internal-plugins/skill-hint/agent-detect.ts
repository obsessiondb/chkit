import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type AgentKind =
  | 'claude'
  | 'cursor'
  | 'copilot'
  | 'windsurf'
  | 'roo'
  | 'augment'
  | 'continue'
  | 'trae'
  | 'unknown'

export interface AgentInfo {
  name: string
  skillsDir: string
}

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

export interface AgentRootResult {
  root: string
  agent: AgentKind
}

/**
 * Walk up from `cwd` to find the best directory for installing agent skills.
 *
 * 1. Look for agentic markers (.claude/, .cursor/, CLAUDE.md, etc.)
 * 2. Fall back to the git root (.git)
 * 3. Fall back to `cwd`
 */
export function findAgentRoot(cwd: string): AgentRootResult {
  let dir = cwd
  while (true) {
    for (const marker of AGENT_MARKERS) {
      if (existsSync(join(dir, marker.path))) return { root: dir, agent: marker.agent }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  dir = cwd
  while (true) {
    if (existsSync(join(dir, '.git'))) return { root: dir, agent: 'unknown' }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return { root: cwd, agent: 'unknown' }
}

export function isSkillInstalledAt(root: string, agent: AgentKind): boolean {
  if (agent !== 'unknown') {
    const { skillsDir } = AGENT_REGISTRY[agent]
    if (existsSync(join(root, skillsDir, 'chkit', 'SKILL.md'))) return true
  }
  if (existsSync(join(root, '.agents', 'skills', 'chkit', 'SKILL.md'))) return true
  if (existsSync(join(homedir(), '.claude', 'skills', 'chkit', 'SKILL.md'))) return true
  return false
}
