export { handleBackfillCommand } from './handler.js'
export { createJobsClient, type JobsClient } from './client.js'

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
  {
    command: ['backfill status', 'backfill cancel', 'backfill list'],
    flags: [
      {
        name: '--job-id',
        type: 'string' as const,
        description: 'Remote job ID for status/cancel',
      },
      {
        name: '--service-slug',
        type: 'string' as const,
        description: 'ObsessionDB service slug for listing jobs',
      },
    ],
  },
]
