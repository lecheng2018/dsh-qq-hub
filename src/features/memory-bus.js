// 记忆总线：所有「想记一条 / 想翻记忆」的代码都走这一层，不直接摸具体存储。
//
// 为什么要有它（2026-11-05 排查）：插件曾经同时存在三套记忆——
//   ① features/memory.js 的 BM25 主库（现在唯一真正在跑的，SQLite 存储 + JSON 兜底）
//   ② memory-privacy 自己的 scoped.json 平行库（P0-4 已迁移停用，代码却一直留着，
//      每个新记忆源都得纠结「写到哪边」）
//   ③ memory-sqlite.js（其实是 ① 的存储层，不算独立轨道，但接口藏在 memory.js 内部）
// 三套并存时，「加一个记忆源 = 给每个模块各改一遍」。总线的职责就是把这件事收成一个口：
//
//   bus.add({ text, chat | chatId | scope, ... })   写一条事实记忆
//   bus.addEvent({ text, chat, ... })               写一条经历流水
//   bus.recall(query, { chat | scopes })            按查询检索（作用域过滤在主库，fail-closed）
//   bus.listFor(scopes) / bus.recentEventsFor(...)  后台任务显式声明可见域的读
//   bus.scopeOf(chat) / bus.visibleScopes(chat)     作用域判定的唯一真相
//
// 总线不实现存储：它只做「入口统一 + 作用域口径统一 + 主库不在时明确报错」，
// 底下仍然是 features/memory.js 那一套（它的去重/清晰度/遗忘/SQLite 都比这里强）。
// 以后真要加新轨道（比如向量库），在 createMemoryStore 后面加实现、总线分发，调用方一行不改。

import { visibleScopes, isVisible, scopeOf } from '../modules/memory-privacy/index.js'

export { visibleScopes, isVisible, scopeOf }

/**
 * 建一个记忆总线。
 * @param {object} o
 * @param {object|null} o.store  createMemoryStore 的实例（主库）。null 时写操作明确失败，读操作返回空——绝不静默丢。
 * @param {object} [o.log]      可选 logger（info/warn/debug）
 */
export function createMemoryBus({ store, log } = {}) {
  const logOf = () => log || null
  const warn = (msg, err) => { try { logOf()?.warn?.(msg, err?.message || err) } catch {} }
  const debug = (msg, err) => { try { logOf()?.debug?.(msg, err?.message || err) } catch {} }

  if (!store) warn('记忆总线：主记忆库没有挂上（memory 模块没在跑？），所有写入会明确失败')

  const requireStore = (verb) => {
    if (store && typeof store.add === 'function') return store
    debug(`记忆总线：${verb}失败，主记忆库不在`)
    return null
  }

  /**
   * 写一条事实记忆。
   * @param {{ text: string, chat?: object, chatId?: string, scope?: string, about?: string, aboutName?: string,
   *           importance?: number, tags?: string[], source?: string }} o
   *  作用域优先级：显式 scope > chat（按聊天推） > chatId（按 id 推）。
   *  和主库 add 自己的兜底一致：都推不出来时落主人私聊，绝不落 global。
   */
  function add(o = {}) {
    const st = requireStore('add')
    if (!st) return { ok: false, message: '主记忆库没在跑' }
    return st.add({
      text: o.text,
      about: o.about || '',
      aboutName: o.aboutName || '',
      tags: o.tags || [],
      importance: o.importance ?? 0.6,
      source: o.source || 'tool',
      sourceId: o.sourceId || '',
      chatId: o.chatId || (o.chat && o.chat.chatId) || '',
      scope: o.scope || '',
      ephemeral: Boolean(o.ephemeral),
      pinned: Boolean(o.pinned),
      evidence: o.evidence || '',
    })
  }

  /** 写一条经历流水（自动打「经历」标签；she 做过什么/看到什么走这个）。 */
  function addEvent(o = {}) {
    const st = requireStore('addEvent')
    if (!st) return { ok: false, message: '主记忆库没在跑' }
    return st.addEvent({
      text: o.text,
      about: o.about || '',
      aboutName: o.aboutName || '',
      tags: o.tags || [],
      importance: o.importance ?? 0.45,
      chat: o.chat || null,
      chatId: o.chatId || '',
      scope: o.scope || '',
      ephemeral: Boolean(o.ephemeral),
      sourceId: o.sourceId || '',
      evidence: o.evidence || '',
    })
  }

  /** 原子替代一条旧事实（C-01 规范） */
  function supersede(o = {}) {
    const st = requireStore('supersede')
    if (!st || typeof st.supersede !== 'function') return { ok: false, message: '主记忆库未就绪' }
    return st.supersede(o)
  }

  /**
   * 按查询检索（主库负责作用域过滤，fail-closed）。
   * @param {string} query
   * @param {{ chat?: object, scopes?: string[]|string, limit?: number }} [o]
   *  给了 chat 就按它算可见域；显式 scopes 优先（后台任务没有 chat 时用）。
   *  两个都没有 → 原样透传 scopes:null（主人全库路径，如面板搜索），由主库自行决定。
   */
  function recall(query, o = {}) {
    if (!store || typeof store.recall !== 'function') return []
    // 主库 recall 的原生语义：scopes=null 且没有 chat 时不限域（面板搜索这类主人全库路径用）。
    // 总线沿用：调用方既没给 chat 也没给 scopes 时，透传 scopes:null 让主库自己决定，
    // 而不是自作主张返回空 —— heybox 预览、面板路径依赖这个行为。
    const hasChat = Boolean(o.chat)
    const hasScopes = o.scopes !== undefined && o.scopes !== null
    const scopes = hasScopes ? (Array.isArray(o.scopes) ? o.scopes : [o.scopes]) : (hasChat ? visibleScopes(o.chat) : null)
    try {
      return store.recall(query, { ...o, scopes }) || []
    } catch (error) {
      warn('记忆总线：recall 失败', error)
      return []
    }
  }

  /** 后台任务专用读：显式声明可见域的事实记忆（不给域一律空，fail-closed）。 */
  function listFor(scopes, opts) {
    if (!store || typeof store.listFor !== 'function') return []
    return store.listFor(scopes, opts) || []
  }

  /** 后台任务专用读：显式声明可见域的近期经历流水。 */
  function recentEventsFor(scopes, hours, limit) {
    if (!store || typeof store.recentEventsFor !== 'function') return []
    return store.recentEventsFor(scopes, hours, limit) || []
  }

  /** 面板/管理用：全库条目（主人自用，不走作用域过滤）。 */
  function list(q) {
    if (!store || typeof store.list !== 'function') return []
    return store.list(q) || []
  }

  function remove(id) {
    if (!store || typeof store.remove !== 'function') return false
    try { return store.remove(id) } catch (error) { warn('记忆总线：remove 失败', error); return false }
  }

  return {
    add, addEvent, supersede, recall, listFor, recentEventsFor, list, remove,
    /** 作用域口径的唯一真相（转发 memory-privacy 的纯函数） */
    scopeOf: (chat) => scopeOf(chat),
    visibleScopes: (chat) => visibleScopes(chat),
    isVisible: (item, chat) => isVisible(item, chat),
    /** 主库本身的实例（面板统计这类「要看全貌」的场合用；别拿它绕过总线写数据） */
    store: () => store,
  }
}
