// 定时规则计算：计算某时刻之后的下一次执行时间
// 支持 once, daily, weekly, workdays, interval, cron

import {
  zonedParts, zonedToUtc, parseDate, parseTime, fmtTime, fmtDate, daysInMonth, addDays, weekdayOf
} from './time.js'

export const SCHEDULE_TYPES = Object.freeze([
  'once', 'daily', 'weekly', 'workdays', 'monthly', 'interval', 'cron'
])

const CRON_FIELDS = [
  { name: '分', min: 0, max: 59 },
  { name: '时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 7 },
]

function parseCronField(text, f) {
  const s = text.trim()
  if (s === '*') return { set: new Set(), any: true }
  const set = new Set()
  for (const part of s.split(',')) {
    const stepMatch = /^([^-/]+)(?:\/(\d+))?$/.exec(part)
    if (!stepMatch) continue
    const base = stepMatch[1]
    const step = stepMatch[2] ? Number(stepMatch[2]) : 1
    if (base === '*') {
      for (let i = f.min; i <= f.max; i += step) set.add(i)
    } else if (base.includes('-')) {
      const [fromStr, toStr] = base.split('-')
      const from = Number(fromStr)
      const to = Number(toStr)
      for (let i = from; i <= to; i += step) set.add(i)
    } else {
      set.add(Number(base))
    }
  }
  return { set, any: false }
}

export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('cron 表达式必须是 5 段（分 时 日 月 周）')
  return parts.map((p, i) => parseCronField(p, CRON_FIELDS[i]))
}

function matchCron(cron, parts, weekday) {
  const [min, hour, dom, mon, dow] = cron
  if (!min.any && !min.set.has(parts.minute)) return false
  if (!hour.any && !hour.set.has(parts.hour)) return false
  if (!mon.any && !mon.set.has(parts.month)) return false
  const matchDom = dom.any || dom.set.has(parts.day)
  const matchDow = dow.any || dow.set.has(weekday % 7) || (weekday === 7 && dow.set.has(7))
  if (dom.any && dow.any) return true
  if (!dom.any && !dow.any) return matchDom || matchDow
  return matchDom && matchDow
}

/**
 * 计算 schedule 在 afterMs 之后的下一次执行时刻
 * @returns {number|null} 毫秒时间戳，已结束返回 null
 */
export function nextOccurrence(schedule, afterMs, { tz = 'Asia/Shanghai' } = {}) {
  const type = schedule?.type
  if (!type) return null

  // 1. 一次性任务 once
  if (type === 'once') {
    const d = parseDate(schedule.date)
    const t = parseTime(schedule.time)
    if (!d || !t) return null
    const ms = zonedToUtc({ ...d, ...t, second: 0 }, tz)
    return ms > afterMs ? ms : null
  }

  // 2. 固定间隔 interval (每隔 N 分钟)
  if (type === 'interval') {
    const every = Number(schedule.everyMinutes) || 30
    const step = every * 60_000
    return Math.floor(afterMs / step) * step + step
  }

  // 3. 每日 daily / 工作日 workdays / 每周 weekly
  const currentParts = zonedParts(afterMs, tz)
  let scanDay = { year: currentParts.year, month: currentParts.month, day: currentParts.day }

  // 扫描未来最多 60 天
  for (let dayOffset = 0; dayOffset < 60; dayOffset++) {
    const wd = weekdayOf(scanDay)

    let dayMatches = false
    if (type === 'daily') {
      dayMatches = true
    } else if (type === 'workdays') {
      dayMatches = wd >= 1 && wd <= 5
    } else if (type === 'weekly') {
      const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [schedule.weekday]
      dayMatches = weekdays.includes(wd)
    } else if (type === 'monthly') {
      const days = Array.isArray(schedule.days) ? schedule.days : [schedule.day]
      const maxDay = daysInMonth(scanDay.year, scanDay.month)
      dayMatches = days.some((d) => (d === -1 ? scanDay.day === maxDay : scanDay.day === Number(d)))
    } else if (type === 'cron') {
      const parsedCron = parseCron(schedule.expr)
      // 检查当前这一天是否有分钟命中
      for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m++) {
          if (matchCron(parsedCron, { ...scanDay, hour: h, minute: m }, wd)) {
            const ms = zonedToUtc({ ...scanDay, hour: h, minute: m, second: 0 }, tz)
            if (ms > afterMs) return ms
          }
        }
      }
    }

    if (dayMatches && type !== 'cron') {
      const times = Array.isArray(schedule.times) ? schedule.times : (schedule.time ? [schedule.time] : ['09:00'])
      for (const tStr of times) {
        const t = parseTime(tStr)
        if (!t) continue
        const candidateMs = zonedToUtc({ ...scanDay, ...t, second: 0 }, tz)
        if (candidateMs > afterMs) {
          return candidateMs
        }
      }
    }

    scanDay = addDays(scanDay, 1)
  }

  return null
}
