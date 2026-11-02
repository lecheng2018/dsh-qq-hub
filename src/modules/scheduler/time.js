// 时间与时区小工具：无第三方依赖，纯 Node 内置 Intl + Date

export const KNOWN_TIMEZONES = [
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore',
  'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
]

export function isValidTimeZone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** 毫秒时间戳 → 指定时区的 { year, month, day, hour, minute, second } */
export function zonedParts(ms, timeZone = 'Asia/Shanghai') {
  const d = new Date(ms)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  })
  const parts = {}
  for (const p of dtf.formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return parts
}

/** 某时区的 { year, month, day, hour, minute, second } 换回 UTC 毫秒时间戳 */
export function zonedToUtc(parts, timeZone = 'Asia/Shanghai') {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = parts
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const offset = guess - zonedToUtcSame(guess, timeZone)
  return guess + offset
}

function zonedToUtcSame(ms, timeZone) {
  const p = zonedParts(ms, timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
}

export function parseDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || '').trim())
  if (!m) return null
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

export function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

export function fmtTime(p) {
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

export function fmtDate(p) {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function addDays(parts, n) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + n))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** 1=周一 … 7=周日 */
export function weekdayOf(parts) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  return d === 0 ? 7 : d
}

export function dayDiff(a, b) {
  const da = Date.UTC(a.year, a.month - 1, a.day)
  const db = Date.UTC(b.year, b.month - 1, b.day)
  return Math.round((db - da) / 86400000)
}
