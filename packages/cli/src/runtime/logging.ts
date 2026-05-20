import process from 'node:process'

import { configureSync, getConfig, getConsoleSink, getTextFormatter } from '@logtape/logtape'

const enabled = process.env.CHKIT_DEBUG === '1' || process.env.CHKIT_DEBUG === 'true'

export function configureCliLogging(): void {
  if (!enabled || getConfig()) return

  configureSync({
    sinks: {
      console: getConsoleSink({
        formatter: getTextFormatter({ timestamp: 'time' }),
      }),
    },
    loggers: [
      {
        category: 'chkit',
        sinks: ['console'],
        lowestLevel: 'debug',
      },
      {
        category: 'logtape',
        sinks: ['console'],
        lowestLevel: 'error',
      },
    ],
    reset: true,
  })
}

export function isDebugEnabled(): boolean {
  return enabled
}
