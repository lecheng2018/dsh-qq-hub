// 记忆作用域过滤、人设可见性判定与倒排/分词缓存。
// 集中管理 indexFor / indexAll / tokCache 以及精准或全量失效（invalidate / invalidateMany）。

import { DEFAULT_PERSONA_ID, isEntryVisibleToPersona } from './memory-persona-track.js'
import { buildIndex, tokenize } from './memory-core.js'
import { personaIdFor } from '../persona/personas.js'
import { chatViewFromKey } from '../chat/adapters/legacy-context.js'

/**
 * 创建记忆索引与作用域过滤缓存。
 */
export function createMemoryIndexCache({ getConfig, load, getRev, derived, getKnownScopes, noteVectorScopes } = {}) {
  /** 解析指定聊天（或全局）当前激活的人设 id：支持按群/按私聊分设人设（personaIdFor）。 */
  const activePersonaId = (chatOrKey = null) => {
    try {
      const cfg = getConfig() || {}
      if (chatOrKey) {
        let view = null
        if (typeof chatOrKey === 'object') {
          view = chatOrKey
        } else {
          const raw = String(chatOrKey).trim()
          const key = raw.startsWith('qq:') ? `private:${raw.slice(3)}` : raw
          if (key.startsWith('private:') || key.startsWith('group:')) view = chatViewFromKey(key)
        }
        if (view) {
          const resolved = String(personaIdFor(view, cfg) || '').trim()
          if (resolved) return resolved
        }
      }
      return String(cfg?.persona?.current || '').trim() || DEFAULT_PERSONA_ID
    } catch {
      return DEFAULT_PERSONA_ID
    }
  }

  /** 读取侧隔离：主观自传按当前聊天人设过滤，客观事实跨人设共享。 */
  const personaVisible = (item, chatOrKey = null) => isEntryVisibleToPersona(item, activePersonaId(chatOrKey))

  /** 已知作用域集合（由 session 的 prevVectorScopes 提供）：用来枚举 override 可能放行的域。 */
  const knownScopes = () => {
    try {
      const set = typeof getKnownScopes === 'function' ? getKnownScopes() : null
      return set instanceof Set ? set : new Set()
    } catch {
      return new Set()
    }
  }

  // 作用域索引缓存（按 scope + override 放行结果分组）；任何写入都会失效
  const cache = new Map() // key -> { stamp, count, idx }
  // tokenize 结果缓存（id → { text, toks }）：add 的 dup 预筛每次扫几百上千条，避免重复切词。
  // 校验 text 一致性并在正文改写时 delete，避免陈旧切词误判去重。
  const tokCache = new Map()
  const tokOf = (m) => {
    const text = String(m.text || '')
    const hit = tokCache.get(m.id)
    if (hit && hit.text === text) return hit.toks
    const toks = new Set(tokenize(text))
    tokCache.set(m.id, { text, toks })
    return toks
  }

  let scopeOverrideFn = null

  function invalidate(scope = '') {
    // T3.8：global 是「所有会话都可见」的那一份，任何 global 变更都必须整体失效；
    // 只删 `scope:global` 会把各会话已建好的 chat 键留在缓存里（旧内容继续被召回）。
    if (String(scope).trim() === 'global') {
      cache.clear()
      if (tokCache.size > 8000) tokCache.clear()
      return
    }
    if (scope) {
      // 缓存键可能是 `scope:x` 或 `chat:x|...`：两种都清，避免按 scope 失效漏掉 chat 键
      cache.delete(`scope:${scope}`)
      cache.delete(String(scope))
      for (const key of cache.keys()) {
        if (String(key).startsWith(`chat:${scope}|`)) cache.delete(key)
      }
      cache.delete('__all__')
    } else {
      cache.clear()
    }
    if (tokCache.size > 8000) tokCache.clear()
  }

  function invalidateMany(scopes = [], { tokenIds = null } = {}) {
    if (Array.isArray(scopes) && scopes.length) {
      for (const sc of scopes) {
        if (String(sc).trim() === 'global') {
          cache.clear() // global 被子作用域缓存引用，整体清最安全
          continue
        }
        if (sc) {
          cache.delete(String(sc))
          cache.delete(`scope:${sc}`)
          // 失效范围要覆盖「override 后半段包含关系」：sc 为某个前缀作用域时，
          // 形如 `chat:<sc>|...` 与 `scope:<sc>:*` 的键都要一起清，否则面板改完仍读到旧索引。
          for (const key of cache.keys()) {
            const k = String(key)
            if (k.startsWith(`chat:${sc}|`) || k === `chat:${sc}` || k.startsWith(`scope:${sc}:`) || k.startsWith(`${sc}:`)) cache.delete(key)
          }
        }
      }
      cache.delete('__all__')
    } else {
      cache.clear()
    }
    if (tokenIds) {
      for (const id of tokenIds) {
        if (id) tokCache.delete(id)
      }
    }
    if (tokCache.size > 8000) tokCache.clear()
  }

  function invalidateToken(id) {
    if (id) tokCache.delete(id)
  }

  function invalidateAll() {
    cache.clear()
    tokCache.clear()
  }

  /**
   * 记忆作用域：私聊里记的只在那个私聊可见，群里记的只在那群可见，global 到处可见。
   */
  function scopeOfChat(chat) {
    // T3.8 fail-closed：system / 未知 kind 绝不返回 'global' —— 返回 global 会让内部会话
    // （系统回合、面板探针）看到所有人的记忆，也会让 clearScope 误清全局。
    if (!chat) return 'private:unknown'
    if (chat.kind === 'system') return 'private:unknown'
    if (chat.kind === 'private') return `private:${chat.userId}`
    if (chat.kind === 'group') return `group:${chat.groupId}`
    return 'private:unknown'
  }

  /** 从 chatId 字符串（'private:123' / 'group:456'）反推作用域；推不出时返回空（fail-closed）。 */
  function scopeFromChatId(chatId) {
    const id = String(chatId || '')
    if (id.startsWith('private:') || id.startsWith('group:')) return id
    return ''
  }

  function registerScopeOverride(fn) {
    scopeOverrideFn = typeof fn === 'function' ? fn : null
    invalidate() // 放行规则变了，按作用域建的索引全部重建
  }

  function isScopeOverridden(scope, chat) {
    return Boolean(scopeOverrideFn && scopeOverrideFn(scope, chat))
  }

  function scopeVisible(scope, chat) {
    const raw = String(scope || '').trim()
    if (!raw) return false
    // T3.8：先判会话本身 —— system/未知会话一律不可见（连 global 也不给），
    // 否则内部回合会把「全局记忆」当成自己的上下文。
    if (!chat || chat.kind === 'system') return false
    if (raw === 'global') return true
    if (raw === scopeOfChat(chat)) return true
    if (scopeOverrideFn && scopeOverrideFn(raw, chat)) return true
    return false
  }

  /** 全量索引：只在主人自己的管理路径用（面板列表、导出等）。 */
  const indexAll = () => {
    const s = load()
    const stamp = (s.rev || 0) + ':' + s.items.length
    const hit = cache.get('__all__')
    if (hit && hit.stamp === stamp) return hit.idx
    const idx = buildIndex(s.items)
    cache.set('__all__', { stamp, idx })
    return idx
  }

  function scopeKeyOf(chatOrScope) {
    if (chatOrScope === 'global') return 'global'
    if (chatOrScope && typeof chatOrScope === 'object') return scopeOfChat(chatOrScope)
    if (typeof chatOrScope === 'string' && chatOrScope.trim()) return chatOrScope.trim()
    return ''
  }

  /**
   * 索引缓存键：字符串 scope 与 chat 对象必须分开缓存。
   * chat 对象还要带上「override 实际放行了哪些域」——放行规则变了（开关/分组调整）键就变，缓存立即失效，
   * 避免 relatedTo 之类按字符串建的索引被 chat 索引反向投毒。
   */
  function indexCacheKey(scope, chatLike, known = knownScopes()) {
    if (!chatLike || !scopeOverrideFn) return `scope:${scope}`
    const extra = []
    for (const sc of known) {
      if (!sc || sc === 'global' || sc === scope) continue
      try { if (scopeOverrideFn(sc, chatLike)) extra.push(sc) } catch { /* 放行规则自身抛错：忽略该域 */ }
    }
    extra.sort()
    return `chat:${scope}|${extra.join(',')}`
  }

  function indexFor(chatOrScope) {
    const scope = scopeKeyOf(chatOrScope)
    if (!scope) return buildIndex([]) // fail-closed：没说清楚给谁看，就什么都不给
    const chatLike = chatOrScope && typeof chatOrScope === 'object' ? chatOrScope : null
    const cacheKey = indexCacheKey(scope, chatLike)
    // 缓存按存储版本失效，重载与正文写入都会递增 rev。
    const revNow = typeof getRev === 'function' ? getRev() : null
    if (revNow === null || revNow === undefined) {
      const s0 = load()
      const hit0 = cache.get(cacheKey)
      if (hit0 && hit0.stamp === (s0.rev || 0) && hit0.count === s0.items.length) return hit0.idx
    } else {
      const hit0 = cache.get(cacheKey)
      if (hit0 && hit0.stamp === revNow) return hit0.idx
    }
    const s = load()
    // 把库里出现的作用域登记进已知集合，后续 override 枚举才有候选（否则冷启动时放行域永远不被考虑）
    if (typeof noteVectorScopes === 'function') {
      noteVectorScopes(s.items.map((m) => String(m.scope || '').trim()))
    } else {
      const known = knownScopes()
      for (const m of s.items) {
        const sc = String(m.scope || '').trim()
        if (sc) known.add(sc)
      }
    }
    const finalKey = indexCacheKey(scope, chatLike)
    const visible = s.items.filter((m) => {
      const sc = String(m.scope || '').trim()
      if (!sc) return false
      if (sc === 'global' || sc === scope) return true
      return chatLike && scopeOverrideFn && scopeOverrideFn(sc, chatLike)
    })
    const stamp = s.rev || 0
    const hit = cache.get(finalKey)
    if (hit && hit.stamp === stamp && hit.count === s.items.length) return hit.idx
    const idx = buildIndex(visible)
    cache.set(finalKey, { stamp, count: s.items.length, idx })
    return idx
  }

  return {
    activePersonaId,
    personaVisible,
    scopeOfChat,
    scopeFromChatId,
    registerScopeOverride,
    isScopeOverridden,
    hasScopeOverride: () => Boolean(scopeOverrideFn),
    scopeVisible,
    tokOf,
    invalidate,
    invalidateMany,
    invalidateToken,
    invalidateAll,
    indexAll,
    indexFor,
    derived,
  }
}
