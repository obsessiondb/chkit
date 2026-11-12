import type { MaterializedViewRefresh } from '@chkit/core'

/**
 * Maps a Tinybird `COPY_SCHEDULE` cron to a ClickHouse refresh schedule, when
 * ClickHouse fires at exactly the same instants. ClickHouse aligns
 * `REFRESH EVERY` to calendar boundaries (`EVERY 6 HOUR` fires at 00, 06, 12,
 * 18; weeks start on Monday) and `OFFSET` moves every firing by a fixed amount,
 * so only crons that are one fixed point per minute, hour, day, week or month
 * (or a minute or hour step that divides the hour or day) translate. Anything
 * else returns the reason.
 */
export type CronTranslation =
  | { ok: true; refresh: Pick<MaterializedViewRefresh, 'every' | 'offset'> }
  | { ok: false; reason: string }

const NUMBER = /^\d+$/

export function cronToRefresh(cron: string | undefined): CronTranslation {
  if (!cron || !cron.trim()) return { ok: false, reason: 'the copy pipe has no COPY_SCHEDULE' }
  const schedule = cron.trim()
  if (schedule.toLowerCase() === '@on-demand') {
    return { ok: false, reason: 'COPY_SCHEDULE @on-demand: Tinybird runs it only when called; a refreshable materialized view always runs on a schedule' }
  }
  const fields = schedule.split(/\s+/)
  if (fields.length !== 5) return { ok: false, reason: `COPY_SCHEDULE "${schedule}" is not a five-field cron` }
  const [minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = fields
  const fail = (why: string): CronTranslation => ({ ok: false, reason: `COPY_SCHEDULE "${schedule}": ${why}` })

  if (month !== '*') return fail('a month field other than * has no REFRESH equivalent')
  if (dayOfMonth !== '*' && dayOfWeek !== '*') return fail('cron fires when either day field matches, which REFRESH cannot express')

  const minuteStep = minute === '*' ? 1 : step(minute)
  if (minuteStep !== undefined) {
    if (hour !== '*' || dayOfMonth !== '*' || dayOfWeek !== '*') return fail('a minute step combined with other fields has no REFRESH equivalent')
    if (minuteStep < 1 || minuteStep > 59 || 60 % minuteStep !== 0) return fail(`a */${minuteStep} minute step does not divide the hour`)
    return { ok: true, refresh: { every: `${minuteStep} MINUTE` } }
  }
  const m = fixed(minute, 0, 59)
  if (m === undefined) return fail('the minute field must be a single value or a step that divides the hour')
  const hourStep = step(hour)
  if (hourStep !== undefined) {
    if (dayOfMonth !== '*' || dayOfWeek !== '*') return fail('an hour step combined with a day field has no REFRESH equivalent')
    if (hourStep < 1 || hourStep > 23 || 24 % hourStep !== 0) return fail(`a */${hourStep} hour step does not divide the day`)
    return { ok: true, refresh: withOffset(`${hourStep} HOUR`, { minute: m }) }
  }
  if (hour === '*') {
    if (dayOfMonth !== '*' || dayOfWeek !== '*') return fail('an every-hour schedule restricted to some days has no REFRESH equivalent')
    return { ok: true, refresh: withOffset('1 HOUR', { minute: m }) }
  }
  const h = fixed(hour, 0, 23)
  if (h === undefined) return fail('the hour field must be a single value, * or a step that divides the day')
  if (dayOfMonth === '*' && dayOfWeek === '*') return { ok: true, refresh: withOffset('1 DAY', { hour: h, minute: m }) }
  if (dayOfWeek !== '*') {
    const d = fixed(dayOfWeek, 0, 7)
    if (d === undefined) return fail('the day-of-week field must be a single day')
    return { ok: true, refresh: withOffset('1 WEEK', { day: (d + 6) % 7, hour: h, minute: m }) }
  }
  const dom = fixed(dayOfMonth, 1, 31)
  if (dom === undefined) return fail('the day-of-month field must be a single day')
  if (dom > 28) return fail(`day ${dom} does not exist in every month; ClickHouse would fire on a different day in short months`)
  return { ok: true, refresh: withOffset('1 MONTH', { day: dom - 1, hour: h, minute: m }) }
}

/** `*\/N` as N. */
function step(field: string): number | undefined {
  const match = /^\*\/(\d+)$/.exec(field)
  return match ? Number(match[1]) : undefined
}

function fixed(field: string, min: number, max: number): number | undefined {
  if (!NUMBER.test(field)) return undefined
  const value = Number(field)
  return value >= min && value <= max ? value : undefined
}

function withOffset(every: string, offset: { day?: number; hour?: number; minute?: number }): Pick<MaterializedViewRefresh, 'every' | 'offset'> {
  const parts = [
    offset.day ? `${offset.day} DAY` : '',
    offset.hour ? `${offset.hour} HOUR` : '',
    offset.minute ? `${offset.minute} MINUTE` : '',
  ].filter(Boolean)
  return parts.length > 0 ? { every, offset: parts.join(' ') } : { every }
}
