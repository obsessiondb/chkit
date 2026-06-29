export { handleBackfillCommand } from './handler.js'
export { createJobsClient, type JobsClient } from './client.js'

// Flags are registered against the top-level `backfill` command, not against
// `backfill <sub>` names: the command registry keys plugin extensions by the
// plugin command name (`byName.get('backfill')`), so two-word subcommand targets
// never match and the flags would silently never register.
export const BACKFILL_EXTEND_COMMANDS = [
  {
    command: ['backfill'],
    flags: [
      {
        name: '--local',
        type: 'boolean' as const,
        description: 'Force local execution (skip remote routing)',
      },
    ],
  },
  {
    command: ['backfill'],
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
