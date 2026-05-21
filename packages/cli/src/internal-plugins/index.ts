import type { ChxPlugin } from '../plugins.js'

import { corePlugin } from './core/plugin.js'
import { createSkillHintPlugin } from './skill-hint/plugin.js'

export function getInternalPlugins(): ChxPlugin[] {
  return [corePlugin, createSkillHintPlugin()]
}
