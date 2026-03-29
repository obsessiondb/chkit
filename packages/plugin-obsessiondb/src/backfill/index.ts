export { handleBackfillCommand } from './handler.js'

export const BACKFILL_EXTEND_COMMANDS = [
  {
    command: ['backfill plan', 'backfill run', 'backfill resume', 'backfill status', 'backfill cancel', 'backfill doctor'],
    flags: [
      {
        name: '--local',
        type: 'boolean' as const,
        description: 'Force local execution (skip remote routing)',
      },
    ],
  },
]
