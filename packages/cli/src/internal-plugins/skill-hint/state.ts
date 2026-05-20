import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SkillHintState {
  lastDismissed?: string
}

export const HINT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

function stateDir(): string {
  return join(homedir(), '.chkit')
}

function stateFilePath(): string {
  return join(stateDir(), 'skill-hint.json')
}

export function readSkillHintState(): SkillHintState {
  try {
    return JSON.parse(readFileSync(stateFilePath(), 'utf-8')) as SkillHintState
  } catch {
    return {}
  }
}

export function writeSkillHintState(state: SkillHintState): void {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(stateFilePath(), `${JSON.stringify(state, null, 2)}\n`)
}
