import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../core/store.js'
import { redact } from '../core/redact.js'

const dayOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const validDay = (day) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return false
  const [year, month, date] = String(day).split('-').map(Number)
  const parsed = new Date(year, month - 1, date)
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === date
}

function fingerprint(lines, count) {
  return createHash('sha256').update(lines.slice(0, count).map((line) => line + '\n').join('')).digest('hex')
}

export function fingerprintChatLog(records) {
  return fingerprint((records || []).map((record) => JSON.stringify(record)), (records || []).length)
}

export function createChatLog({ getConfig = () => ({}), log = console, now = Date.now } = {}) {
  const dir = () => dataDir('chatlog')
  let retentionTimer = null

  function append(chatId, who, text, uid = '') {
    const d = new Date(now())
    const day = dayOf(d)
    mkdirSync(dir(), { recursive: true })
    const cfg = getConfig() || {}
    const uidText = String(uid || '')
    const ownerName = uidText && uidText === String(cfg.ownerQQ || '') ? String(cfg.ownerName || '主人') : ''
    const author = String(who || '').trim() || ownerName || uidText || (String(chatId).startsWith('private:') ? String(chatId).slice(8) : '群成员')
    const entry = { t: d.getTime(), chatId, who: author, ...(uid ? { uid: uidText } : {}), text: redact(String(text).slice(0, 500)) }
    appendFileSync(join(dir(), `${day}.jsonl`), JSON.stringify(entry) + '\n', 'utf8')
    return entry
  }

  function listDays() {
    try {
      return readdirSync(dir())
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && validDay(name.slice(0, 10)))
        .map((name) => name.slice(0, 10))
        .sort()
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  function readDaySnapshot(day) {
    if (!validDay(day)) throw new Error(`无效的聊天流水日期: ${String(day)}`)
    const file = join(dir(), `${day}.jsonl`)
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') raw = ''
      else throw error
    }
    const sourceLines = raw.split(/\r?\n/).map((line, index) => ({ line, lineNo: index + 1 })).filter(({ line }) => line)
    const lines = sourceLines.map(({ line }) => line)
    const records = sourceLines.map(({ line, lineNo }) => {
      try {
        const value = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('流水记录必须是对象')
        return value
      } catch (error) {
        throw new Error(`聊天流水 ${day}.jsonl 行 ${lineNo} 无效: ${error.message}`, { cause: error })
      }
    })
    return {
      day,
      records,
      fingerprint: fingerprint(lines, lines.length),
      prefixFingerprint: (count) => {
        const n = Number(count)
        if (!Number.isSafeInteger(n) || n < 0 || n > records.length) throw new RangeError(`聊天流水 ${day} 的指纹行数无效: ${count}`)
        return fingerprint(lines, n)
      },
    }
  }

  function readDay(day) {
    return readDaySnapshot(day).records
  }

  function pruneBefore(cutoffDay) {
    if (!validDay(cutoffDay)) throw new Error(`无效的聊天流水保留截止日期: ${String(cutoffDay)}`)
    const removed = []
    for (const day of listDays()) {
      if (day >= cutoffDay) continue
      try {
        unlinkSync(join(dir(), `${day}.jsonl`))
        removed.push(day)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return removed
  }

  function pruneExpired() {
    const keepDays = Math.max(14, Number(getConfig()?.chatlog?.keepDays) || 30)
    const cutoff = dayOf(new Date(now() - keepDays * 86400_000))
    const removed = pruneBefore(cutoff)
    if (removed.length) log.info?.(`聊天流水：清理了 ${removed.length} 天前的旧文件（保留 ${keepDays} 天）`)
    return removed
  }

  function stopRetention() {
    if (!retentionTimer) return
    clearInterval(retentionTimer)
    retentionTimer = null
  }

  function startRetention({ intervalMs = 60 * 60_000 } = {}) {
    if (retentionTimer) return stopRetention
    const run = () => {
      try { pruneExpired() } catch (error) { log.warn?.('聊天流水保留清理失败：', error.message) }
    }
    run()
    retentionTimer = setInterval(run, Math.max(60_000, Number(intervalMs) || 60 * 60_000))
    retentionTimer.unref?.()
    return stopRetention
  }

  function dispose() {
    stopRetention()
  }

  return { append, listDays, readDay, readDaySnapshot, pruneBefore, pruneExpired, startRetention, dispose }
}

export function readChatLogSource(chatLog, day) {
  if (chatLog.readDaySnapshot) return { day, ...chatLog.readDaySnapshot(day) }
  const records = structuredClone(chatLog.readDay(day))
  return { day, records, prefixFingerprint: (count) => fingerprintChatLog(records.slice(0, count)) }
}

export function chatLogCursor(snapshot, count = snapshot.records.length) {
  return { count, fingerprint: snapshot.prefixFingerprint(count) }
}

export function chatLogOffset(snapshot, previous) {
  if (!previous) return 0
  if (!Number.isSafeInteger(previous.count) || previous.count < 0 || !/^[a-f0-9]{64}$/.test(previous.fingerprint || '')) {
    throw new Error(`${snapshot.day} 的共享流水消费进度无效，请核对后恢复`)
  }
  if (previous.count > snapshot.records.length) throw new Error(`${snapshot.day} 的共享流水已缩短，请核对消费进度`)
  if (snapshot.prefixFingerprint(previous.count) !== previous.fingerprint) {
    throw new Error(`${snapshot.day} 的共享流水已被替换，请核对来源后恢复`)
  }
  return previous.count
}

export function createChatLogApi(service) {
  return Object.freeze({
    append: (...args) => service.append(...args),
    listDays: () => service.listDays(),
    readDay: (day) => service.readDay(day),
    readDaySnapshot: (day) => service.readDaySnapshot(day),
  })
}
