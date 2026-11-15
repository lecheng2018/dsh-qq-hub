// 日志：按天写文件 + 内存里留最近几百条给面板看。所有文本先脱敏。

import { appendFileSync, readdirSync, unlinkSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, ensureDir } from './store.js'
import { redact } from './redact.js'

const RING = 500
const LEVELS = ['debug', 'info', 'warn', 'error']

export function createLogger({ dsh, retainDays = 14 } = {}) {
  const ring = []
  const listeners = new Set()
  const chmodDone = new Set() // 当天已 chmod 过的日志文件（append 创建新文件时 umask 077 会锁 0o600）
  const dir = () => ensureDir(dataDir('logs'))
  let lastCleanup = 0

  function cleanup() {
    const now = Date.now()
    if (now - lastCleanup < 6 * 3600_000) return
    lastCleanup = now
    try {
      for (const name of readdirSync(dir())) {
        const p = join(dir(), name)
        if (now - statSync(p).mtimeMs > retainDays * 86400_000) unlinkSync(p)
      }
    } catch (error) {}
  }

  function write(level, area, message) {
    const text = redact(message)
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    const entry = { t: d.getTime(), time, level, area, text }
    ring.push(entry)
    if (ring.length > RING) ring.shift()
    try {
      const logFile = join(dir(), `qq-hub-${day}.log`)
      appendFileSync(logFile, `${day} ${time} [${level}] [${area}] ${text}\n`, 'utf8')
      // 同 store.js：umask 077 部署环境新建的日志是 Harness 私有，运维放开组读活不过次日。
      // 每个日志文件只在当天第一次写入后 chmod 一次。
      if (!chmodDone.has(logFile)) {
        chmodDone.add(logFile)
        try { chmodSync(logFile, 0o644) } catch {}
      }
    } catch (error) {}
    try {
      const fn = level === 'error' ? dsh?.logger?.error : level === 'warn' ? dsh?.logger?.warn : dsh?.logger?.info
      if (level !== 'debug') fn?.call(dsh.logger, `qq-hub[${area}]: ${text}`)
    } catch (error) {}
    for (const l of listeners) {
      try { l(entry) } catch (error) {}
    }
    cleanup()
    return entry
  }

  const api = {
    child(area) {
      const c = {}
      for (const lv of LEVELS) c[lv] = (...args) => write(lv, area, args.map(fmt).join(' '))
      return c
    },
    recent(limit = 200, filter = {}) {
      return ring
        .filter((e) => (!filter.level || LEVELS.indexOf(e.level) >= LEVELS.indexOf(filter.level)) && (!filter.area || e.area === filter.area))
        .slice(-limit)
    },
    onEntry(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  return api
}

function fmt(v) {
  if (v instanceof Error) return v.message
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch (error) { return String(v) }
}
