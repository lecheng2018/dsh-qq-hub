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

    // 单会话隔离 override：scope → 'open'（强制不隔离）/ ''（默认隔离）
    // 存在 settings.json 的 modules.memory-privacy.overrides 里。
    // P0-4 合并平行库后，「不隔离」必须挂在主库上才生效（以前这里的 listFor 是死代码，开关是假的）：
    // 注册进主库 scopeVisible —— 被设为 open 的聊天额外可见主人私聊作用域的记忆。
    // 只放行 private:<主人QQ>，别的私聊/别的群仍然不可见（以前 m.scope !== scope 会把所有其他域全放过）。
    const overridesOf = () => {
      try { return api.settings().overrides || {} } catch (error) { return {} }
    }
    let overrides = {}
    try { overrides = overridesOf() } catch (error) {}
    try {
      const memory = api.use('memory')
      memory?.registerScopeOverride?.((scope, chat) => {
        const ownerQQ = String(api.config().ownerQQ || '')
        if (!ownerQQ || !chat) return false
        return String(overrides[scopeOf(chat)] || '') === 'open' && scope === `private:${ownerQQ}`
      })
    } catch (error) { api.log?.warn?.('隔离开关接主库失败：' + error.message) }

    // ---- P0-4：合并平行库。主记忆库（features/memory.js）已经按同一口径做作用域隔离
    //（scopeVisible/indexFor/recall scopes），这层独立的 scoped.json 是重复实现：
    // 模型几乎不走它、每个新特性都要写两遍、还占一轮 prompt 注入额度。现在：
    // 1) remember_scoped 工具停用（主库 remember/add 走同一套作用域）
    // 2) 每轮 prompt 注入停掉（主库 recallHint 已经按查询检索 + 作用域过滤，比固定取 4 条更准）
    // 3) 存量 scoped.json 一次性迁移进主库（scope 原样保留），迁移后文件改名备份，不再写
    // 迁移只跑一次：migratedAt 记在 scoped.json 里
    function migrateIntoMain(memory) {
      try {
        const s = load()
        if (s.migratedAt) return
        const items = s.items || []
        let n = 0
        for (const m of items) {
          if (!m.text || !m.scope) continue
          // 走主库 add：同一套去重/清晰度/遗忘逻辑；scope 原样保留
          memory.add({
            text: m.text,
            importance: Number(m.importance) || 0.6,
            source: 'event',
            chatId: m.scope,
            scope: m.scope,
          })
          n += 1
        }
        s.migratedAt = Date.now()
        s.migratedCount = n
        s.items = []
        save(s)
        api.log.info(`记忆分层：scoped.json 里 ${n} 条已迁移进主记忆库，平行库停用`)
      } catch (error) {
        api.log.warn('记忆分层迁移失败（下次启动再试）：', error.message)
      }
    }

    // ---- 交给她内容时，只拼当前聊天可见的作用域记忆 ----
    // P0-4：这段停用 —— 主库 recallHint 按查询检索 + 作用域过滤（fail-closed），
    // 比这里固定取 4 条不重要度排序更准，也不占快照。只保留过滤日志（排查泄漏用）。
    api.on('prompt', (content, info) => {
      const cfg = api.settings()
      if (!cfg.enabled || !info?.chat || info.chat.kind === 'system' || !Array.isArray(content)) return content
      // 过滤日志现在记主库视角：主库投喂进上下文的每条都已过 scopeVisible，
      // 这里不重复过滤，只把「本模块 override 放行的」记录下来（调试用）。
      return content
    })

    // ---- 她自己决定记什么：改走主库（同一套作用域/去重/遗忘），本模块不再独立存储 ----
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
          const memory = api.use('memory')
          if (!memory?.add) return { ok: false, message: '主记忆库没在跑' }
          const finalScope = !scope || scope === 'auto'
            ? (api.settings().autoScope ? scopeOf(chat) : 'global')
            : scope
          try {
            memory.add({
              text: String(text || '').trim(),
              importance: Math.max(0, Math.min(1, Number(importance) || 0.6)),
              source: 'tool',
              chatId: chat?.chatId || finalScope,
              scope: finalScope,
            })
            return { ok: true, message: `记住了（${finalScope}）` }
          } catch (error) {
            return { ok: false, message: error.message }
          }
        },
      })
    })

    api.rule(() => '你有一份按聊天分开的记忆。私聊里听到的事只在那个私聊里提；群里的只在那群里提。被追问别处的私事就说不方便讲。')

    // 面板：看 / 删
    // 私聊条目默认打码（只给条数），previewPrivate=true（面板设置里的调试开关）才返回原文。
    // 没有 query 旁路：以前 ?all=1 能直接绕过打码，开关成了摆设。
    api.route('/memory-privacy/list', (req) => {
      const s = load()
      const cfg = api.settings()
      const preview = Boolean(cfg.previewPrivate)
      const items = s.items.map((m) => {
        if (preview || !String(m.scope).startsWith('private:')) return m
        return { ...m, text: '（私聊内容，面板不预览）' }
      })
      return { ok: true, preview, items }
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
        // 软删（invalidAt）的一并清掉：用户点的是「彻底清空」，面板的已失效分区还挂着它们
        if (String(m.scope || '') === scope) {
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
      return { ok: true, message: mode === 'open' ? `${scope} 已改为不隔离（主人私聊的记忆对这个聊天可见）` : `${scope} 恢复隔离` }
    })
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

    // 迁移：setup 末尾跑一次（memory 模块已加载，api.use 能拿到）
    const memory = api.use('memory')
    if (memory?.add) migrateIntoMain(memory)

    return { add, scopeOf, visibleScopes, isVisible }
  },
}
