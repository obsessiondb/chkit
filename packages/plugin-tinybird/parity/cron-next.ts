/**
 * The next time a five-field cron fires after `after`, in UTC, by checking
 * every minute. Full cron semantics (lists, ranges, steps, the day-of-month /
 * day-of-week OR rule), written independently of the plugin's cron mapping so
 * the parity checks compare the plugin against something it does not share
 * code with.
 */
export function nextCronFire(cron: string, after: Date): Date {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.trim().split(/\s+/)
  if (dayOfWeek === undefined) throw new Error(`not a five-field cron: ${cron}`)
  const minutes = field(minute ?? '', 0, 59)
  const hours = field(hour ?? '', 0, 23)
  const days = field(dayOfMonth ?? '', 1, 31)
  const months = field(month ?? '', 1, 12)
  const weekdays = new Set([...field(dayOfWeek, 0, 7)].map((day) => day % 7))
  const dayRestricted = dayOfMonth !== '*'
  const weekdayRestricted = dayOfWeek !== '*'

  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000
  for (let t = start, end = start + 400 * 86_400_000; t < end; t += 60_000) {
    const date = new Date(t)
    if (!minutes.has(date.getUTCMinutes()) || !hours.has(date.getUTCHours()) || !months.has(date.getUTCMonth() + 1)) continue
    const dayMatch = days.has(date.getUTCDate())
    const weekdayMatch = weekdays.has(date.getUTCDay())
    const matches = dayRestricted && weekdayRestricted ? dayMatch || weekdayMatch : dayMatch && weekdayMatch
    if (matches) return date
  }
  throw new Error(`cron ${cron} does not fire within 400 days`)
}

function field(text: string, min: number, max: number): Set<number> {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const [range = '', stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    const [from, to] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(Number) : [Number(range), stepText === undefined ? Number(range) : max]
    if (from === undefined || to === undefined || Number.isNaN(from) || Number.isNaN(to) || !(step > 0)) {
      throw new Error(`cannot read cron field ${text}`)
    }
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return values
}
