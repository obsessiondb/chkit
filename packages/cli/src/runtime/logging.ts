import process from 'node:process'

import { configureSync, getConfig, getConsoleSink, getTextFormatter, type Sink } from '@logtape/logtape'

const enabled = process.env.CHKIT_DEBUG === '1' || process.env.CHKIT_DEBUG === 'true'

// Every level goes to stderr: stdout carries only command output (one JSON
// document with --json). The default map sends debug and info to
// console.debug/info, which Bun and Node print on stdout.
function getStderrSink(): Sink {
  return getConsoleSink({
    formatter: getTextFormatter({ timestamp: 'time' }),
    levelMap: {
      trace: 'error',
      debug: 'error',
      info: 'error',
      warning: 'error',
      error: 'error',
      fatal: 'error',
    },
  })
}

export function configureCliLogging(): void {
  if (!enabled || getConfig()) return

  configureSync({
    sinks: {
      console: getStderrSink(),
      // A sink of its own: logtape reports a failing sink on the meta logger
      // and skips that sink while doing so.
      meta: getStderrSink(),
    },
    loggers: [
      {
        category: 'chkit',
        sinks: ['console'],
        lowestLevel: 'debug',
      },
      {
        // An array: logtape recognizes its meta logger only by an array
        // category, and otherwise adds its own console sink (stdout) and
        // prints a "loggers are configured" banner there.
        category: ['logtape'],
        sinks: ['meta'],
        lowestLevel: 'error',
      },
    ],
    reset: true,
  })
}

export function isDebugEnabled(): boolean {
  return enabled
}
