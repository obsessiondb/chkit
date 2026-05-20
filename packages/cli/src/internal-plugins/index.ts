import type { ChxPlugin } from '../plugins.js'

import { createSkillHintPlugin } from './skill-hint/plugin.js'

export function getInternalPlugins(): ChxPlugin[] {
  return [createSkillHintPlugin()]
}
