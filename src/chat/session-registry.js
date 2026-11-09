// M2-B · Session Registry：ChatKey → DSH session/agent 映射（纯模块，fake DSH 即可全测）
//
// 职责（任务书 M2-B）：
//   1. 同一聊天并发首消息只创建一次（single-flight）；
//   2. 不同聊天绝不串 session；
//   3. 创建失败释放 in-flight（下次重试，不留死锁）；
//   4. 显式 dispose（卸载时清干净，不留定时器/监听器）；
//   5. 持久化经适配接口（session-store），重启可恢复；旧映射只读迁移、损坏记录失败关闭。
// preset/workspace 保持 DSH 语义：本模块只管「聊天→session」映射与并发，不碰提示词。
//
// 红线：不 import hub/OneBot/host；对 DSH 只依赖注入的 sessionAdapter 接口。

import { parseChatKey } from './chat-key.js'

/**
 * @param {object} o
 * @param {(chatKey: string, hint?: object) => Promise<{sessionId: string, agentId?: string}>} o.createSession
 *   创建 DSH session 的注入实现（fake/真实 DSH 适配器都实现这个签名）
 * @param {object} [o.store] 持久化适配（session-store 的实现；缺省 = 内存态，不持久化）
 * @param {(error: Error) => void} [o.onError] 持久化错误出口（默认吞掉并计入 stats）
 */
export function createSessionRegistry({ createSession, store, onError = () => {} } = {}) {
  if (typeof createSession !== 'function') throw new TypeError('createSession 必须是函数')

  /** chatKey -> { sessionId, agentId?, createdAt } */
  const sessions = new Map()
  /** chatKey -> Promise<entry>（single-flight 窗口） */
  const inFlight = new Map()
  let disposed = false
  const stats = { created: 0, recovered: 0, failed: 0, storeErrors: 0 }

  // 启动恢复：store 里已有映射直接读回（重启不重建会话）
  if (store?.load) {
    try {
      const persisted = store.load()
      for (const [chatKey, entry] of Object.entries(persisted || {})) {
        try {
          parseChatKey(chatKey)
          if (!entry?.sessionId) continue
          sessions.set(chatKey, { sessionId: String(entry.sessionId), agentId: entry.agentId ? String(entry.agentId) : undefined, createdAt: Number(entry.createdAt) || 0, ...(Number(entry.lastTurnAt) > 0 ? { lastTurnAt: Number(entry.lastTurnAt) } : {}), restored: true })
          stats.recovered++
        } catch {
          // 单条损坏：跳过该条（不拖垮整库），由 onError 上报
          onError(new Error(`损坏的 session 映射记录：${chatKey}`))
        }
      }
    } catch (error) {
      // 整库读失败：失败关闭——当作空映射启动，绝不猜半份脏数据
      stats.storeErrors++
      onError(error)
    }
  }

  function persist(chatKey, entry) {
    if (!store?.save) return
    try {
      const snapshot = {}
      for (const [k, v] of sessions) snapshot[k] = { sessionId: v.sessionId, ...(v.agentId ? { agentId: v.agentId } : {}), createdAt: v.createdAt, ...(v.lastTurnAt ? { lastTurnAt: v.lastTurnAt } : {}) }
      void chatKey
      store.save(snapshot)
    } catch (error) {
      stats.storeErrors++
      onError(error)
    }
  }

  /**
   * 取（或创建）聊天的 session。同聊天并发调用共享同一次创建（single-flight）。
   * @returns {Promise<{sessionId: string, agentId?: string, created: boolean}>}
   *   created=true 仅发生在真正发起 DSH 创建的那次调用（leader）；共享等待方 created=false。
   */
  async function sessionFor(chatKey, hint) {
    if (disposed) throw new Error('session registry 已卸载')
    parseChatKey(chatKey) // 非法 ChatKey 直接抛，绝不创建无主映射
    const hit = sessions.get(chatKey)
    if (hit) return { ...hit, created: false }

    const pending = inFlight.get(chatKey)
    if (pending) return pending.promise.then((entry) => ({ ...entry, created: false }))

    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    inFlight.set(chatKey, { promise })
    ;(async () => {
      try {
        const created = await createSession(chatKey, hint)
        if (!created?.sessionId) throw new Error('createSession 未返回 sessionId')
        const entry = { sessionId: String(created.sessionId), ...(created.agentId ? { agentId: String(created.agentId) } : {}), createdAt: Date.now() }
        sessions.set(chatKey, entry)
        stats.created++
        persist(chatKey, entry)
        resolve(entry)
      } catch (error) {
        stats.failed++
        reject(error) // 失败：in-flight 释放（finally），下次调用可重试
      } finally {
        inFlight.delete(chatKey)
      }
    })()
    return promise.then((entry) => ({ ...entry, created: true }))
  }

  /** 只读视图：该聊天是否有映射（不创建）。 */
  function peek(chatKey) {
    const hit = sessions.get(chatKey)
    return hit ? { ...hit } : null
  }

  /** 显式忘掉一个聊天（reset 命令/删工作区用）：下次消息开新会话。 */
  function forget(chatKey) {
    parseChatKey(chatKey)
    const had = sessions.delete(chatKey)
    persist(chatKey, null)
    return had
  }

  function markTurn(chatKey, now = Date.now()) {
    const hit = sessions.get(chatKey)
    const previous = Number(hit?.lastTurnAt || 0)
    if (hit) {
      hit.lastTurnAt = now
      persist(chatKey, hit)
    }
    return previous
  }

  /** 全量只读快照（面板/诊断用）。 */
  function snapshot() {
    return Object.fromEntries([...sessions.entries()].map(([k, v]) => [k, { ...v }]))
  }

  /** 卸载：拒绝新请求，等待在飞的创建自然落定后清空内存（持久化交由 store 自身）。 */
  async function dispose() {
    disposed = true
    const pending = [...inFlight.values()]
    await Promise.allSettled(pending.map((p) => p.promise))
    sessions.clear()
    inFlight.clear()
  }

  return { sessionFor, peek, forget, markTurn, snapshot, dispose, stats }
}
