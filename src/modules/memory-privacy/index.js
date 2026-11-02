// 移植自 h-D-ACE/dsh-qq 的 memory-policy.js：记忆隐私分层（Memory Privacy）
//
// dsh-qq 的核心约束：记忆有作用域，私聊记忆在**代码注入层被物理拦截**，
// 无论模型被怎么套话都读不到。三个作用域：
//   private:<QQ>  只在这个人的私聊里可见
//   group:<群号>  只在这个群里可见
//   global        哪里都能用
//
// aurabot 的记忆本体在 features/memory.js，recall/recallHint 不区分作用域。
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
  return ['global']
}

/** 一条记忆在当前聊天里可见吗？ */
export function isVisible(item, chat) {
  if (!item) return false
  // system（她自己后台想事情）会话不该看到任何分层记忆
  if (!chat || chat.kind === 'system') return false
  const scope = String(item.scope || 'global')
  if (scope === 'global') return true
  return visibleScopes(chat).includes(scope)
}

export function scopeOf(chat) {
  if (!chat || chat.kind === 'system') return 'global'
  if (chat.kind === 'private') return `private:${chat.userId}`
  if (chat.kind === 'group') return `group:${chat.groupId}`
  return 'global'
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
  },
  settings: [
    { key: 'enabled', label: '启用记忆分层', type: 'switch', hint: '关掉就只有原来的 BM25 记忆，不额外加分层内容' },
    { key: 'maxItems', label: '每次最多带几条', type: 'number', min: 0, max: 12, step: 1 },
    { key: 'maxChars', label: '内容长度上限', type: 'number', min: 100, max: 2000, step: 50 },
    { key: 'autoScope', label: '自动按聊天作用域', type: 'switch', hint: '私聊记成 private、群聊记成 group' },
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
      return load().items
        .filter((m) => isVisible(m, chat))
        .map((m) => ({ ...m, score: (0.6 + 0.8 * (Number(m.importance) || 0.5)) * (0.6 + 0.4 * Math.exp(-(now - m.at) / (30 * 24 * 3600_000))) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    }

    // ---- 交给她内容时，只拼当前聊天可见的作用域记忆 ----
    api.on('prompt', (content, info) => {
      const cfg = api.settings()
      if (!cfg.enabled || !info?.chat || info.chat.kind === 'system' || !Array.isArray(content)) return content
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
      return { ok: true, items: all ? s.items : s.items.filter((m) => String(m.scope).startsWith('private:')).map((m) => ({ ...m, text: '（私聊内容，面板不预览）' })) }
    })
    // 面板：作用域汇总（私聊内容默认不预览，只给条数；全局和本群可以看）
    api.route('/memory-privacy/stats', () => {
      const s = load()
      const by = {}
      for (const m of s.items) {
        const scope = String(m.scope || 'global')
        by[scope] = (by[scope] || 0) + 1
      }
      return {
        ok: true,
        total: s.items.length,
        scopes: Object.entries(by).map(([scope, n]) => ({ scope, n })).sort((a, b) => b.n - a.n),
        globalItems: s.items.filter((m) => String(m.scope || 'global') === 'global').slice(-50).map((m) => ({ id: m.id, text: m.text, at: m.at })),
      }
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
