// 记忆档案会话与状态管理：迁移门禁、世代取消信号、读写快照、命中计数节流落盘、
// CAS 外部修改自愈事务入口 mutate(fn) 以及 reload / dispose 生命周期控制。

import { existsSync, readFileSync } from 'node:fs'
import { dataDir } from '../core/store.js'
import { openMemoryFiles } from './memory-files.js'

const ABORT_MUTATION = Symbol('abortMutation')

/**
 * 创建记忆状态会话：封装底层 Markdown/state 存储、生命周期与事务一致性。
 */
export function createMemoryStateSession({ log, vec } = {}) {
  if (['memories.db', 'memories.json', 'memories.meta.json'].some((name) => existsSync(dataDir(name)))) {
    let migrated = false
    try {
      migrated = JSON.parse(readFileSync(dataDir('memory/migration.json'), 'utf8')).status === 'success'
        && existsSync(dataDir('memory/state.json'))
    } catch { /* 迁移标记缺失或损坏时保持 false，由下方门禁阻断 */ }
    if (!migrated) {
      throw new Error(`旧记忆库尚未确认迁移，请停写并执行 node scripts/migrate-memory-markdown.js "${dataDir()}"；若 memory/ 已存在，须先人工核对冲突，禁止自动覆盖。`)
    }
  }

  const store = openMemoryFiles(dataDir('memory'), { log })

  let status = 'active' // 'active' | 'closed'
  let activeGeneration = 1
  const abortControllers = new Set()
  const hooks = { onSaved: null, onReload: null, onDispose: null }

  function bindHooks({ onSaved, onReload, onDispose } = {}) {
    if (onSaved) hooks.onSaved = onSaved
    if (onReload) hooks.onReload = onReload
    if (onDispose) hooks.onDispose = onDispose
  }

  function createGenerationSignal(timeoutMs = 60000) {
    const ac = new AbortController()
    const gen = activeGeneration
    abortControllers.add(ac)
    const timer = setTimeout(() => {
      try { ac.abort(new Error('模型请求超时')) } catch { /* 忽略已中止异常 */ }
    }, timeoutMs)
    timer.unref?.()
    return {
      signal: ac.signal,
      isValid: () => status === 'active' && activeGeneration === gen && !ac.signal.aborted,
      cleanup: () => {
        clearTimeout(timer)
        abortControllers.delete(ac)
      },
    }
  }

  function generationOf(genSignal, timeoutMs = 120000) {
    const owned = genSignal ? null : createGenerationSignal(timeoutMs)
    return { signal: genSignal || owned, cleanup: () => owned?.cleanup() }
  }

  // 只读路径的「同一次调用内共用一份快照」；写路径一律走 loadFresh()，绝不吃快照。
  let snapMemo = null
  const load = () => {
    if (status === 'closed') throw new Error('主记忆库已关闭')
    return snapMemo || store.load()
  }
  const loadFresh = () => {
    if (status === 'closed') throw new Error('主记忆库已关闭')
    return store.load()
  }
  function withSnapshot(fn) {
    if (snapMemo) return fn()
    snapMemo = store.load()
    try {
      return fn()
    } finally {
      snapMemo = null
    }
  }

  const pendingHitUpdates = new Map()
  let hitFlushTimer = null

  function scheduleFlushHits() {
    if (hitFlushTimer) return
    hitFlushTimer = setTimeout(() => {
      hitFlushTimer = null
      try { flushHits() } catch (error) { log?.warn?.('记忆命中统计保存失败：', error.message) }
    }, 5000)
    hitFlushTimer.unref?.()
  }

  function recordHits(hits) {
    if (!hits || !hits.length) return
    const now = Date.now()
    const todayStr = new Date().toDateString()
    for (const h of hits) {
      const id = h.it.id
      const cur = pendingHitUpdates.get(id) || {
        hits: 0,
        lastHit: 0,
        hitDays: 0,
        lastDayStr: h.it.lastHit ? new Date(h.it.lastHit).toDateString() : '',
      }
      cur.hits += 1
      cur.lastHit = now
      if (cur.lastDayStr !== todayStr) {
        cur.hitDays += 1
        cur.lastDayStr = todayStr
      }
      pendingHitUpdates.set(id, cur)
    }
    scheduleFlushHits()
  }

  let prevVectorScopes = new Set(
    (() => { try { return (load().items || []).map((m) => String(m.scope || '').trim()).filter(Boolean) } catch { return [] } })(),
  )

  const save = (s) => {
    if (status === 'closed') throw new Error('主记忆库已关闭')
    for (const [id, delta] of pendingHitUpdates) {
      const m = s.items.find((x) => x.id === id)
      if (m) {
        if (delta.hitDays) m.hitDays = (m.hitDays || 0) + delta.hitDays
        m.hits = (m.hits || 0) + delta.hits
        m.lastHit = delta.lastHit
      }
    }
    store.save(s)
    // 向量通道：整作用域对账入队（防抖 15s，只 embed 缺失/文本变更的条目）。失败只告警，不影响主路径。
    try {
      if (vec?.enabled()) {
        const byScope = new Map()
        const currentScopes = new Set()
        for (const m of s.items) {
          const sc = String(m.scope || '').trim()
          if (!sc) continue
          currentScopes.add(sc)
          if (m.invalidAt) continue
          const list = byScope.get(sc) || []
          list.push(m)
          byScope.set(sc, list)
        }
        for (const [sc, list] of byScope) vec.queueScope(sc, list)
        for (const gone of prevVectorScopes) {
          if (!currentScopes.has(gone)) vec.queueScope(gone, [])
        }
        prevVectorScopes = currentScopes
      }
    } catch (error) { log?.debug?.('向量入队失败：' + (error && error.message)) }
    pendingHitUpdates.clear()
    if (hitFlushTimer) { clearTimeout(hitFlushTimer); hitFlushTimer = null }
    hooks.onSaved?.(s)
  }

  /**
   * 事务入口：读取最新状态执行变更并落盘；若遇健康状态下的外部并发修改（CAS 冲突），
   * 自动重载一次并重跑事务以完成自愈。文件损坏时直接抛出原始错误，绝不强行覆盖。
   */
  let mutating = false
  function mutate(fn, { maxRetries = 1 } = {}) {
    if (status === 'closed') throw new Error('主记忆库已关闭')
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const s = loadFresh()
      let aborted = false
      let abortValue
      const abort = (value) => {
        aborted = true
        abortValue = value
        return ABORT_MUTATION
      }
      mutating = true
      let result
      try {
        result = fn(s, abort)
      } finally {
        mutating = false
      }
      if (aborted || result === ABORT_MUTATION) return abortValue
      try {
        save(s)
        return result
      } catch (error) {
        const isCasConflict = attempt < maxRetries && /已在外部被修改/.test(String(error?.message || ''))
        if (!isCasConflict) throw error
        const reloaded = reload({ quiet: true })
        if (!reloaded.ok) throw error
        log?.warn?.(`记忆写入遇到外部并发修改，已自动重载并重试：${error.message}`)
      }
    }
    return undefined
  }

  function flushHits() {
    if (pendingHitUpdates.size) mutate(() => true)
  }

  function reload({ quiet = false } = {}) {
    if (status === 'closed') throw new Error('记忆模块已关闭')
    activeGeneration++
    for (const ac of abortControllers) ac.abort(new Error('memory reloaded'))
    abortControllers.clear()
    if (hitFlushTimer) { clearTimeout(hitFlushTimer); hitFlushTimer = null }
    store.reload()
    hooks.onReload?.()
    const health = store.health()
    const message = health.ok ? '记忆档案已重新载入，索引已更新' : '部分档案或状态损坏，请修复后重新载入；自动整理已暂停'
    if (!quiet) log?.info?.(message)
    return { ok: health.ok, health, message }
  }

  function dispose() {
    if (status === 'closed') return
    try { flushHits() } catch { /* 关闭阶段尽力刷盘，失败不阻断清理 */ }
    if (hitFlushTimer) { clearTimeout(hitFlushTimer); hitFlushTimer = null }
    try { hooks.onDispose?.() } catch { /* 忽略向量通道清理异常 */ }
    status = 'closed'
    activeGeneration++
    for (const ac of abortControllers) {
      try { ac.abort(new Error('memory disposed')) } catch { /* 忽略重复中止 */ }
    }
    abortControllers.clear()
    try { store.close() } catch { /* 忽略重复关闭 */ }
  }

  return {
    bindHooks,
    isActive: () => status === 'active',
    isClosed: () => status === 'closed',
    isMutating: () => mutating,
    createGenerationSignal,
    generationOf,
    load,
    loadFresh,
    withSnapshot,
    save,
    mutate,
    recordHits,
    flushHits,
    scheduleFlushHits,
    reload,
    dispose,
    health: () => store.health(),
    rev: () => (typeof store?.rev === 'function' ? store.rev() : null),
    getVectorScopes: () => new Set(prevVectorScopes),
  }
}
