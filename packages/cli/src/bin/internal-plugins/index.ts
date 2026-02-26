import type { ChxPlugin } from '../../plugins.js'

import { createSkillHintPlugin } from './skill-hint.js'

export function getInternalPlugins(): ChxPlugin[] {
  return [createSkillHintPlugin()]
}
