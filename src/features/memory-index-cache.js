// 记忆作用域过滤、人设可见性判定与倒排/分词缓存。
// 集中管理 indexFor / indexAll / tokCache 以及精准或全量失效（invalidate / invalidateMany）。

import { DEFAULT_PERSONA_ID, isEntryVisibleToPersona } from './memory-persona-track.js'
import { buildIndex, tokenize } from './memory-core.js'
import { personaIdFor } from '../persona/personas.js'
import { chatViewFromKey } from '../chat/adapters/legacy-context.js'

/**
 * 创建记忆索引与作用域过滤缓存。
 */
export function createMemoryIndexCache({ getConfig, load, getRev, derived } = {}) {
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

  // 作用域索引缓存（按 scope 分组）；任何写入都会失效
  const cache = new Map() // scope -> { stamp, count, idx }
  // tokenize 结果缓存（id → Set）：add 的 dup 预筛每次扫几百上千条，避免重复切词
  const tokCache = new Map()
  const tokOf = (m) => {
    let t = tokCache.get(m.id)
    if (!t) {
      t = new Set(tokenize(m.text))
      tokCache.set(m.id, t)
    }
    return t
  }

  let scopeOverrideFn = null

  function invalidate(scope = '') {
    if (scope) {
      cache.delete(scope)
      cache.delete('__all__')
    } else {
      cache.clear()
    }
    if (tokCache.size > 8000) tokCache.clear()
  }

  function invalidateMany(scopes = [], { tokenIds = null } = {}) {
    if (Array.isArray(scopes) && scopes.length) {
      for (const sc of scopes) {
        if (sc) cache.delete(String(sc))
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
    if (!chat || chat.kind === 'system') return 'global'
    if (chat.kind === 'private') return `private:${chat.userId}`
    if (chat.kind === 'group') return `group:${chat.groupId}`
    return 'global'
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
    if (raw === 'global') return true
    if (!chat || chat.kind === 'system') return false
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

  function indexFor(chatOrScope) {
    const scope = scopeKeyOf(chatOrScope)
    if (!scope) return buildIndex([]) // fail-closed：没说清楚给谁看，就什么都不给
    const chatLike = chatOrScope && typeof chatOrScope === 'object' ? chatOrScope : null
    const revNow = typeof getRev === 'function' ? getRev() : null
    if (revNow === null || revNow === undefined) {
      const s0 = load()
      const hit0 = cache.get(scope)
      if (hit0 && hit0.stamp === (s0.rev || 0) && hit0.count === s0.items.length) return hit0.idx
    } else {
      const hit0 = cache.get(scope)
      if (hit0 && hit0.stamp === revNow) return hit0.idx
    }
    const s = load()
    const visible = s.items.filter((m) => {
      const sc = String(m.scope || '').trim()
      if (!sc) return false
      if (sc === 'global' || sc === scope) return true
      return chatLike && scopeOverrideFn && scopeOverrideFn(sc, chatLike)
    })
    const stamp = s.rev || 0
    const hit = cache.get(scope)
    if (hit && hit.stamp === stamp && hit.count === s.items.length) return hit.idx
    const idx = buildIndex(visible)
    cache.set(scope, { stamp, count: s.items.length, idx })
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
