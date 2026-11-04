// 移植自 h-D-ACE/dsh-qq 的 memory-policy.js：记忆隐私分层（Memory Privacy）
//
// dsh-qq 的核心约束：记忆有作用域，私聊记忆在**代码注入层被物理拦截**，
// 无论模型被怎么套话都读不到。三个作用域：
//   private:<QQ>  只在这个人的私聊里可见
//   group:<群号>  只在这个群里可见
//   global        哪里都能用
//
// 注：qq-hub 的记忆本体在 features/memory.js，它自己现在也按作用域隔离了
// （indexFor/scopeVisible），这里并列的是一层独立的作用域记忆库，两者口径保持一致。
// 这个模块不改它，而是并列一层"作用域记忆库"：
// - 她可以用工具把事记到某个作用域（默认：私聊记 private，群里记 group）
// - 交给她内容时（'prompt' 事件），只把**当前聊天可见**的作用域记忆拼进去
// - 群聊里 private:* 的记忆条目在进入模型上下文之前就被过滤掉，不是靠模型自觉
//
// 这样即使 BM25 记忆库被套话，敏感内容根本不在上下文里。

import { readJson, writeJson } from '../../core/store.js'
import { randomUUID } from 'node:crypto'

const ID = 'memory-privacy'
const SCOPES = ['private', 'group', 'global']

/** 当前聊天能看到哪些作用域。 */
export function visibleScopes(chat) {
  if (!chat || chat.kind === 'system') return []
  if (chat.kind === 'private') return [`private:${chat.userId}`, 'global']
  if (chat.kind === 'group') return [`group:${chat.groupId}`, 'global']
  // 认不出来的聊天类型：只给 global，不给任何人的私有内容
  return ['global']
}

/** 一条记忆在当前聊天里可见吗？ */
export function isVisible(item, chat) {
  if (!item) return false
  // system（她自己后台想事情）会话不该看到任何分层记忆
  if (!chat || chat.kind === 'system') return false
  const scope = String(item.scope || '').trim()
  // 无 scope 的按「不可见」处理，不再默认当 global。
  // 和 features/memory.js 的 scopeVisible 保持同一口径：认不出来源就不给，
  // 否则一批没写 scope 的老条目会在任何聊天里都可见。
  if (!scope) return false
  if (scope === 'global') return true
  return visibleScopes(chat).includes(scope)
}

export function scopeOf(chat) {
  if (!chat || chat.kind === 'system') return 'global'
  if (chat.kind === 'private') return `private:${chat.userId}`
  if (chat.kind === 'group') return `group:${chat.groupId}`
  // 认不出来的聊天类型，不要默认写进 global —— 那等于把内容直接公开。
  // 退到一个谁也不共享的私有作用域，宁可自己看不到，也不让它漏给别人。
  return 'private:unknown'
}

export default {
  id: ID,
  name: '记忆分层',
  version: '1.0.0',
  api: 1,
  description: '移植自 dsh-qq：私聊里说的事只在私聊可见，群里怎么套也拿不到',
  panel: 'panel.js',
  tab: 'mood',
  defaults: {
    enabled: true,
    /** 每次最多带上几条作用域记忆 */
    maxItems: 4,
    /** 拼进提示词的总长度上限 */
    maxChars: 400,
    /** 默认作用域：私聊记 private，群里记 group */
    autoScope: true,
    /** 私聊分区在面板里预览（默认关：面板不是 she 用的，打开方便调试） */
    previewPrivate: false,
    /** 分层记忆不足时，允许补几条 global 兜底（0=不补） */
    globalFallback: 0,
  },
  settings: [
    { key: 'enabled', label: '启用记忆分层', type: 'switch', hint: '关掉就只有原来的 BM25 记忆，不额外加分层内容' },
    { key: 'maxItems', label: '每次最多带几条', type: 'number', min: 0, max: 12, step: 1, hint: '0~12，填 0 等于不投喂分层记忆' },
    { key: 'maxChars', label: '内容长度上限', type: 'number', min: 100, max: 2000, step: 50, hint: '100~2000' },
    { key: 'autoScope', label: '自动按聊天作用域', type: 'switch', hint: '开（默认）：私聊记成 private、群聊记成 group。关掉后新记忆一律写进 global —— 任何聊天都能读到，等于放弃隔离，慎用' },
    { key: 'previewPrivate', label: '面板预览私聊分区', type: 'switch', hint: '打开后面板能看到私聊记忆原文（调试用；面板只有你能开）' },
    { key: 'globalFallback', label: 'global 兜底条数', type: 'number', min: 0, max: 12, step: 1, hint: '分层记忆不够时补几条 global（0=不补，默认不补）' },
  ],
  setup(api) {
    const file = () => api.dataDir('scoped.json')
    // { items: [{ id, text, scope, aboutName, importance, at }] }
    const load = () => readJson(file(), { items: [] })
    const save = (s) => { try { writeJson(file(), s) } catch (error) { api.log.warn('保存分层记忆失败：', error.message) } }

    function add({ text, scope, aboutName = '', importance = 0.6, chat = null }) {
      const t = String(text || '').trim().slice(0, 200)
      if (!t) return { ok: false, message: '内容是空的' }
      const finalScope = scope && (scope === 'global' || SCOPES.includes(String(scope).split(':')[0])) ? scope : scopeOf(chat)
      const s = load()
      // 同作用域里几乎一样的就更新，不重复存
      const dup = s.items.find((m) => m.scope === finalScope && m.text === t)
      if (dup) { dup.at = Date.now(); dup.importance = Math.max(Number(dup.importance) || 0, Number(importance) || 0); save(s); return { ok: true, message: '✓', id: dup.id } }
      const item = { id: randomUUID().slice(0, 8), text: t, scope: finalScope, aboutName: String(aboutName || ''), importance: Math.max(0, Math.min(1, Number(importance) || 0.6)), at: Date.now() }
      s.items.push(item)
      if (s.items.length > 2000) s.items = s.items.slice(-2000)
      save(s)
      return { ok: true, message: '✓', id: item.id }
    }

    function listFor(chat, limit = 4) {
      const now = Date.now()
      const cfg = api.settings()
      // 单会话隔离 override：某个作用域强制「不隔离」→ global 也可见
      //（例：某个群想让她知道主人私聊里的事 —— 在面板里把 group:xxx 设为 open）
      const scope = scopeOf(chat)
      const forcedOpen = String(overrides[scope] || '') === 'open'
      let pool = load().items.filter((m) => isVisible(m, chat) || (forcedOpen && m.scope !== scope))
      const picked = pool
        .map((m) => ({ ...m, score: (0.6 + 0.8 * (Number(m.importance) || 0.5)) * (0.6 + 0.4 * Math.exp(-(now - m.at) / (30 * 24 * 3600_000))) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
      // 兜底：分层记忆不够时补 global（globalFallback=0 不补）
      const fb = Math.max(0, Math.min(12, Number(cfg.globalFallback) || 0))
      if (picked.length < limit && fb > 0) {
        const have = new Set(picked.map((m) => m.id))
        const globals = pool.filter((m) => String(m.scope || '') === 'global')
        // global 本来就可见时 isVisible 已放过来了；这里补的是「隔离开的 global 之外」的情况
        const extra = load().items
          .filter((m) => String(m.scope || '') === 'global' && !have.has(m.id))
          .map((m) => ({ ...m, score: (0.6 + 0.8 * (Number(m.importance) || 0.5)) * (0.6 + 0.4 * Math.exp(-(now - m.at) / (30 * 24 * 3600_000))) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.min(fb, limit - picked.length))
        picked.push(...extra)
      }
      return picked
    }

    // 单会话隔离 override：scope → 'open'（强制不隔离，global 可见）/ ''（默认隔离）
    // 存在 settings.json 的 modules.memory-privacy.overrides 里
    const overridesOf = () => {
      try { return api.settings().overrides || {} } catch (error) { return {} }
    }
    let overrides = {}
    try { overrides = overridesOf() } catch (error) {}

    /** 过滤日志：投喂前把被拦下的跨域记忆记下来，方便排查「私聊记忆有没有漏到群里」。
     * 只在面板要看的时候现算（filterLog 存最近 200 条），不落盘 —— 排查工具，不是审计需求。 */
    const filterLog = []
    function recordFilter(chat, blocked) {
      if (!blocked.length) return
      filterLog.push({ at: Date.now(), chat: chat?.chatId || '', kind: chat?.kind || '', blocked: blocked.slice(0, 10).map((m) => ({ id: m.id, scope: m.scope, text: String(m.text || '').slice(0, 50) })) })
      if (filterLog.length > 200) filterLog.splice(0, filterLog.length - 200)
    }

    // ---- 交给她内容时，只拼当前聊天可见的作用域记忆 ----
    api.on('prompt', (content, info) => {
      const cfg = api.settings()
      if (!cfg.enabled || !info?.chat || info.chat.kind === 'system' || !Array.isArray(content)) return content
      // 先算「被拦下哪些」，有拦截才记日志（全放行不记，避免刷屏）
      const all = load().items
      const vis = new Set(listFor(info.chat, Number(cfg.maxItems)).map((m) => m.id))
      const blocked = all.filter((m) => !vis.has(m.id) && m.scope !== 'global' && m.scope !== scopeOf(info.chat))
      recordFilter(info.chat, blocked)
      const items = listFor(info.chat, Number(cfg.maxItems))
      if (!items.length) return content
      let body = items.map((m) => `- ${m.text}`).join('\n')
      if (body.length > Number(cfg.maxChars)) body = body.slice(0, Number(cfg.maxChars)) + '…'
      const where = info.chat.kind === 'private' ? '这次是私聊' : '这次在群里'
      return [{ type: 'text', text: `（${where}，下面是这个聊天里才看得到的记忆，别在别处提到：\n${body}\n）` }, ...content]
    })

    // ---- 她自己决定记什么 ----
    api.tool(({ chat }) => {
      if (!chat || chat.kind === 'system') return []
      return api.defineTool({
        name: 'remember_scoped',
        description: '把一件值得长期记住的事记下来。私聊里记的只有这个私聊看得到，群里的只有这个群看得到；'
          + '要跨聊天通用（比如自己的设定、大家都该知道的事）才用 global。',
        properties: {
          text: { type: 'string', description: '一句话说清这件事，主语写清楚' },
          scope: { type: 'string', enum: ['auto', 'global'], description: 'auto=按当前聊天（推荐），global=所有聊天都能用' },
          importance: { type: 'number', description: '重要程度 0~1，默认 0.6' },
        },
        required: ['text'],
        execute: async ({ text, scope, importance }) => {
          const r = add({ text, scope: !scope || scope === 'auto' ? (api.settings().autoScope ? scopeOf(chat) : 'global') : scope, importance, chat })
          if (!r.ok) return r
          const where = r.id ? (load().items.find((m) => m.id === r.id)?.scope || '') : ''
          return { ok: true, message: `记住了（${where || '当前作用域'}）` }
        },
      })
    })

    api.rule(() => '你有一份按聊天分开的记忆。私聊里听到的事只在那个私聊里提；群里的只在那群里提。被追问别处的私事就说不方便讲。')

    // 面板：看 / 删
    api.route('/memory-privacy/list', (req) => {
      const s = load()
      const all = String(req?.query?.all || '') === '1'
      const cfg = api.settings()
      // 私聊分区预览：默认只给条数（文本打码），previewPrivate 打开后看原文（调试用）
      const preview = Boolean(cfg.previewPrivate)
      return { ok: true, preview, items: all || preview ? s.items : s.items.filter((m) => String(m.scope).startsWith('private:')).map((m) => ({ ...m, text: '（私聊内容，面板不预览）' })) }
    })
    // 单分区清空：删掉某个作用域（private:xxx / group:xxx / global）的全部条目。
    // 只动本模块 scoped.json；主记忆库的清空另有 /memory-privacy/clear-main。
    api.route('/memory-privacy/clear-scope', async (req) => {
      const q = req?.query?.scope || ''
      let body = {}
      if (!q) { try { body = await api.core.http.body(req) } catch (error) {} }
      const scope = String(q || body?.scope || '')
      if (!scope) return { ok: false, message: '要先说清哪个分区' }
      const s = load()
      const before = s.items.length
      s.items = s.items.filter((m) => m.scope !== scope)
      save(s)
      return { ok: true, message: `已清空 ${before - s.items.length} 条（${scope}）` }
    })
    // 主记忆库按作用域清空（同样二次确认在前端做）
    api.route('/memory-privacy/clear-main', async (req) => {
      const q = req?.query?.scope || ''
      let body = {}
      if (!q) { try { body = await api.core.http.body(req) } catch (error) {} }
      const scope = String(q || body?.scope || '')
      if (!scope) return { ok: false, message: '要先说清哪个分区' }
      const memory = api.use('memory')
      if (!memory?.list) return { ok: false, message: '主记忆库没在跑' }
      let n = 0
      for (const m of memory.list() || []) {
        if (String(m.scope || '') === scope && !m.invalidAt) {
          try { memory.remove(m.id); n += 1 } catch (error) {}
        }
      }
      return { ok: true, message: `主记忆库已清空 ${n} 条（${scope}）` }
    })
    // 单会话隔离开关：scope → open（不隔离）/隔离（默认）。存进模块 settings。
    api.route('/memory-privacy/set-override', async (req) => {
      const q = req?.query?.scope || ''
      let body = {}
      if (!q) { try { body = await api.core.http.body(req) } catch (error) {} }
      const scope = String(q || body?.scope || '')
      const mode = String(body?.mode ?? req?.query?.mode ?? '')
      if (!scope) return { ok: false, message: '要先说清哪个分区' }
      overrides[scope] = mode === 'open' ? 'open' : ''
      try { api.saveSettings({ overrides }) } catch (error) { return { ok: false, message: '保存失败：' + error.message } }
      return { ok: true, message: mode === 'open' ? `${scope} 已改为不隔离（global 可见）` : `${scope} 恢复隔离` }
    })
    // 过滤日志：最近 200 次投喂中每次被拦掉的跨域记忆
    api.route('/memory-privacy/filter-log', () => ({ ok: true, items: filterLog.slice().reverse() }))
    // 面板：作用域汇总（私聊内容默认不预览，只给条数；全局和本群可以看）
    // 面板数据以「真正生效的那套」为准：主记忆库的作用域分布 + 人物小档案的作用域分布。
    // 本模块自己的 scoped.json 只是附带的一份，模型几乎不会走它，所以面板不能只报它（否则永远 0 条）。
    api.route('/memory-privacy/stats', () => {
      const s = load()
      const by = {}
      for (const m of s.items) {
        const scope = String(m.scope || 'global')
        by[scope] = (by[scope] || 0) + 1
      }
      const out = {
        ok: true,
        total: s.items.length,
        overrides,
        scopes: Object.entries(by).map(([scope, n]) => ({ scope, n })).sort((a, b) => b.n - a.n),
        globalItems: s.items.filter((m) => String(m.scope || 'global') === 'global').slice(-50).map((m) => ({ id: m.id, text: m.text, at: m.at })),
      }
      // 主记忆库的真实分布
      try {
        const memory = api.use('memory')
        const items = (memory && typeof memory.list === 'function' ? memory.list() : []) || []
        const mainBy = {}
        for (const m of items) {
          const scope = String(m.scope || 'global')
          mainBy[scope] = (mainBy[scope] || 0) + 1
        }
        out.main = {
          total: items.length,
          scopes: Object.entries(mainBy).map(([scope, n]) => ({ scope, n })).sort((a, b) => b.n - a.n),
          globalItems: items.filter((m) => String(m.scope || 'global') === 'global').slice(-50).map((m) => ({ id: m.id, text: m.text, at: m.at })),
          privateCount: items.filter((m) => String(m.scope || '').startsWith('private:')).length,
        }
        // 人物小档案：这是之前真正泄漏的那条通道，单独列出来
        const profs = (memory && typeof memory.profiles === 'function' ? memory.profiles() : []) || []
        const profBy = {}
        for (const p of profs) {
          const scope = String(p.scope || 'global')
          profBy[scope] = (profBy[scope] || 0) + 1
        }
        out.profiles = {
          total: profs.length,
          scopes: Object.entries(profBy).map(([scope, n]) => ({ scope, n })).sort((a, b) => b.n - a.n),
          globalItems: profs.filter((p) => String(p.scope || 'global') === 'global').slice(-50).map((p) => ({ qq: p.qq, text: p.text, at: p.at })),
        }
      } catch (error) {
        out.mainError = error.message
      }
      return out
    })
    api.route('/memory-privacy/delete', (req) => {
      const id = String(req?.query?.id || '')
      const s = load()
      s.items = s.items.filter((m) => m.id !== id)
      save(s)
      return { ok: true }
    })

    return { add, listFor, scopeOf, visibleScopes, isVisible }
  },
}
