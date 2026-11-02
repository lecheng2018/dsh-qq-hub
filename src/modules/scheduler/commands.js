// /remind 命令解析与执行：主人在 QQ 私聊直接管理定时任务

import { fmtDate, fmtTime, zonedParts } from './time.js'

export const REMIND_HELP = [
  '⏰ 定时任务指令帮助（主人专属）：',
  '/remind list —— 查看当前任务列表',
  '/remind in 30m 喝水（m 分钟 / h 小时 / d 天）',
  '/remind once 2026-11-05 09:30 检查周报',
  '/remind daily 08:30 早上打卡',
  '/remind workdays 18:00 下班打卡',
  '/remind weekly 1,3,5 20:00 健身',
  '/remind del 1 —— 删除任务 #1',
  '/remind on 1 · /remind off 1 —— 启停任务 #1',
].join('\n')

const TIME_RE = /^\d{1,2}:\d{2}$/

export function parseRemindCommand(text, { now = Date.now(), tz = 'Asia/Shanghai' } = {}) {
  const raw = String(text ?? '').trim()
  const m = /^[/／]?(?:remind|提醒|定时)(?:\s+([\s\S]*))?$/i.exec(raw)
  if (!m) return null

  const args = (m[1] ?? '').trim()
  if (!args || /^(help|帮助)$/i.test(args)) return { action: 'help' }

  const parts = args.split(/\s+/)
  const verb = parts[0].toLowerCase()

  if (['list', 'ls', '列表'].includes(verb)) {
    return { action: 'list' }
  }

  if (['del', 'rm', 'delete', '删除', 'on', 'off'].includes(verb)) {
    const id = Number(parts[1])
    if (!Number.isInteger(id) || id <= 0) return { error: `请指定任务编号，例如 /remind ${verb} 1` }
    const action = ['del', 'rm', 'delete', '删除'].includes(verb) ? 'delete' : verb
    return { action, id }
  }

  // 支持直接简写：/remind in 30m 喝水，或者 /remind add in 30m 喝水
  const tokens = verb === 'add' ? parts.slice(1) : parts
  const type = (tokens[0] || '').toLowerCase()

  if (type === 'in') {
    const d = /^(\d+)(m|h|d)$/i.exec(tokens[1] || '')
    if (!d) return { error: '时间格式错误，写成 /remind in 30m 内容（m 分钟 / h 小时 / d 天）' }
    const num = Number(d[1])
    const unit = d[2].toLowerCase()
    const ms = num * (unit === 'm' ? 60_000 : unit === 'h' ? 3600_000 : 86400_000)
    const p = zonedParts(now + ms, tz)
    const content = tokens.slice(2).join(' ').trim()
    if (!content) return { error: '请填写提醒内容' }
    return {
      action: 'add',
      task: {
        text: content,
        schedule: { type: 'once', date: fmtDate(p), time: fmtTime(p) }
      }
    }
  }

  if (type === 'once') {
    const date = tokens[1]
    const time = tokens[2]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !TIME_RE.test(time || '')) {
      return { error: '格式错误，例如 /remind once 2026-11-05 09:30 内容' }
    }
    const content = tokens.slice(3).join(' ').trim()
    if (!content) return { error: '请填写提醒内容' }
    return {
      action: 'add',
      task: {
        text: content,
        schedule: { type: 'once', date, time }
      }
    }
  }

  if (type === 'daily' || type === 'workdays') {
    const time = tokens[1]
    if (!TIME_RE.test(time || '')) return { error: `格式错误，例如 /remind ${type} 08:30 内容` }
    const content = tokens.slice(2).join(' ').trim()
    if (!content) return { error: '请填写提醒内容' }
    return {
      action: 'add',
      task: {
        text: content,
        schedule: { type, times: [time] }
      }
    }
  }

  if (type === 'weekly') {
    const daysStr = tokens[1]
    const time = tokens[2]
    const weekdays = (daysStr || '').split(',').map(Number).filter((d) => d >= 1 && d <= 7)
    if (!weekdays.length || !TIME_RE.test(time || '')) {
      return { error: '格式错误，例如 /remind weekly 1,3,5 20:00 内容（1=周一）' }
    }
    const content = tokens.slice(3).join(' ').trim()
    if (!content) return { error: '请填写提醒内容' }
    return {
      action: 'add',
      task: {
        text: content,
        schedule: { type: 'weekly', weekdays, times: [time] }
      }
    }
  }

  return { error: `不认识的规则类型「${type}」。回复 /remind 查看使用说明。` }
}
