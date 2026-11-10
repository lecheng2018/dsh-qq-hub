// M2-B · Session Store：映射持久化适配（JSON 文件实现 + 旧映射只读迁移）
//
// 文件格式（版本化）：
//   { version: 1, savedAt: <ms>, chats: { "<chatKey>": { sessionId, agentId?, createdAt } } }
//
// 迁移语义（任务书 M2-B/M3-B）：旧 hub 的 sessions.json（hub 私有格式）**只读导入**——
// 损坏记录跳过并上报，绝不写回旧文件（不自动反向迁移新数据，回滚时旧路径照常用旧文件）。

import fs from 'node:fs'
import { readJsonWithBackup, writeJsonWithBackup } from '../core/store.js'
import { parseChatKey } from './chat-key.js'

const STORE_VERSION = 1

function validSessionDocument(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value.version === undefined || value.version === STORE_VERSION)
    && value.chats && typeof value.chats === 'object' && !Array.isArray(value.chats))
}

/**
 * JSON 文件存储。
 * @param {object} o
 * @param {string} o.file 存储文件路径
 * @param {(error: Error) => void} [o.onError] 恢复与损坏告警
 */
export function createSessionFileStore({ file, onError = (error) => console.warn(error.message) }) {
  if (!file) throw new TypeError('file 必填')
  const options = { validate: validSessionDocument, label: 'session 映射', onError }
  return {
    /** 读全量映射；无法恢复时抛错，由 registry 告警并以空映射启动。 */
    load() {
      const result = readJsonWithBackup(file, { ...options, fallback: () => ({ version: STORE_VERSION, chats: {} }) })
      if (result.error) throw result.error
      const out = {}
      for (const [k, v] of Object.entries(result.value.chats)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && v.sessionId) out[k] = v
        else onError(new Error(`session 映射 ${file} 中的记录 ${k} 无效，已跳过`))
      }
      return out
    },
    /** 原子写全量映射及备份。 */
    save(snapshot) {
      writeJsonWithBackup(file, { version: STORE_VERSION, savedAt: Date.now(), chats: snapshot ?? {} }, options)
    },
  }
}

/**
 * 旧 hub sessions.json 的只读迁移器（M3-B 迁移语义的 M2 侧前置）。
 * @param {object} o
 * @param {string} o.legacyFile 旧文件路径（hub 私有格式：{ chats: { <chatId>: { sessionId, ... } } }）
 * @param {object} o.store 新 store
 * @param {string} [o.botQQ] 旧文件裸 QQ 号键 → private:<botQQ 拥有的私聊>；群键 `group:<gid>` 直接映射
 * @returns {{ imported: number, skipped: string[], errors: string[], conflicts: string[] }}
 *   conflicts：store 里已有该 chatKey 且 sessionId 与旧值不同——保留新值（陈旧映射不覆盖），键记于此。
 */
export function migrateLegacySessions({ legacyFile, store, onError = () => {} }) {
  const report = { imported: 0, skipped: [], errors: [], conflicts: [] }
  let legacy
  try {
    legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return report // 没有旧文件 = 无需迁移（幂等）
    report.errors.push(`读旧文件失败：${error.message}`)
    onError(error)
    return report
  }
  const chats = legacy?.chats
  if (!chats || typeof chats !== 'object') {
    report.errors.push('旧文件缺 chats 对象')
    return report
  }
  const current = (() => { try { return store.load() } catch { return {} } })()
  const merged = { ...current }
  for (const [key, entry] of Object.entries(chats)) {
    if (!entry?.sessionId) { report.skipped.push(key); continue }
    // 旧键形如 'group:777' / 'private:555' / 裸 QQ 号
    let chatKey = key
    if (!/^(private|group):/.test(key)) chatKey = `private:${key}`
    try {
      parseChatKey(chatKey)
    } catch {
      report.skipped.push(key)
      continue
    }
    const incoming = { sessionId: String(entry.sessionId), ...(entry.createdAt ? { createdAt: Number(entry.createdAt) } : {}) }
    // 重复迁移防倒退：store 里该键已有不同 sessionId 说明旧映射已陈旧（会话已轮换）——
    // 保留 current 的新值不覆盖，键记入 conflicts；同值重复导入仍照常计 imported（幂等语义不变）。
    const existing = current[chatKey]
    if (existing && existing.sessionId !== incoming.sessionId) {
      report.conflicts.push(chatKey)
      continue
    }
    merged[chatKey] = incoming
    report.imported++
  }
  if (report.imported > 0) store.save(merged)
  return report
}
