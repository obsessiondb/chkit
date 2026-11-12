import { describe, expect, test } from 'bun:test'

import { cronToRefresh } from './cron.js'

describe('cronToRefresh', () => {
  test('maps fixed points and dividing steps', () => {
    const cases: Array<[string, { every: string; offset?: string }]> = [
      ['* * * * *', { every: '1 MINUTE' }],
      ['*/1 * * * *', { every: '1 MINUTE' }],
      ['*/15 * * * *', { every: '15 MINUTE' }],
      ['0 * * * *', { every: '1 HOUR' }],
      ['15 * * * *', { every: '1 HOUR', offset: '15 MINUTE' }],
      ['0 */1 * * *', { every: '1 HOUR' }],
      ['5 */6 * * *', { every: '6 HOUR', offset: '5 MINUTE' }],
      ['0 0 * * *', { every: '1 DAY' }],
      ['30 2 * * *', { every: '1 DAY', offset: '2 HOUR 30 MINUTE' }],
      ['0 6 * * 1', { every: '1 WEEK', offset: '6 HOUR' }],
      ['0 0 * * 0', { every: '1 WEEK', offset: '6 DAY' }],
      ['0 0 * * 7', { every: '1 WEEK', offset: '6 DAY' }],
      ['45 23 * * 3', { every: '1 WEEK', offset: '2 DAY 23 HOUR 45 MINUTE' }],
      ['0 4 1 * *', { every: '1 MONTH', offset: '4 HOUR' }],
      ['10 3 28 * *', { every: '1 MONTH', offset: '27 DAY 3 HOUR 10 MINUTE' }],
    ]
    for (const [cron, refresh] of cases) expect({ cron, ...cronToRefresh(cron) }).toEqual({ cron, ok: true, refresh })
  })

  test('reports schedules ClickHouse cannot fire at the same instants', () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, 'the copy pipe has no COPY_SCHEDULE'],
      ['@on-demand', 'COPY_SCHEDULE @on-demand: Tinybird runs it only when called'],
      ['0 0 * *', 'is not a five-field cron'],
      ['*/7 * * * *', 'a */7 minute step does not divide the hour'],
      ['0 */5 * * *', 'a */5 hour step does not divide the day'],
      ['0 9-17 * * 1-5', 'the hour field must be a single value'],
      ['0,30 * * * *', 'the minute field must be a single value'],
      ['0 0 1 1 *', 'a month field other than * has no REFRESH equivalent'],
      ['0 0 1 * 1', 'cron fires when either day field matches'],
      ['0 0 31 * *', 'day 31 does not exist in every month'],
      ['0 * * * 1', 'an every-hour schedule restricted to some days'],
      ['*/5 1 * * *', 'a minute step combined with other fields'],
      ['0 */2 * * 1', 'an hour step combined with a day field'],
      ['0 0 * * 1,3', 'the day-of-week field must be a single day'],
    ]
    for (const [cron, reason] of cases) {
      const translated = cronToRefresh(cron)
      expect(translated.ok).toBe(false)
      expect(!translated.ok && translated.reason).toContain(reason)
    }
  })
})
