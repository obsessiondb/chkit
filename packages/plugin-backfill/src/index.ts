import './table-config.js'

export { backfill, createBackfillPlugin } from './plugin.js'
export { executeBackfill, syncProgress } from './async-backfill.js'
export type {
  BackfillOptions,
  BackfillChunkState,
  BackfillProgress,
  BackfillResult,
} from './async-backfill.js'
export type { BackfillPlugin, BackfillPluginOptions, BackfillPluginRegistration } from './types.js'
export type { PluginConfig } from './options.js'
export type { BackfillTableConfig } from './table-config.js'
