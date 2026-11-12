// 移植自 h-D-ACE/dsh-qq 的 memory-policy.js：记忆隐私分层（Memory Privacy）
//
// 记忆有作用域，私聊记忆在**代码注入层被物理拦截**，无论模型被怎么套话都读不到。三个作用域：
//   private:<QQ>  只在这个人的私聊里可见
//   group:<群号>  只在这个群里可见
//   global        哪里都能用
//
// 本模块现在的职责（1.3.48 起）：**作用域口径的唯一真相** + 隔离开关 + 面板。
// 记忆本体只在主库（features/memory.js，scopeVisible/indexFor 按同一套口径过滤）；
// 所有读写一律走记忆总线（features/memory-bus.js），不再有本模块自己的存储——
// 曾经并行的 scoped.json 在 P0-4 迁移进主库后彻底删除（代码、路由、面板口径一并清理）。
// 下面三个纯函数（scopeOf/visibleScopes/isVisible）是主库、总线和面板共用的口径来源。

const ID = 'memory-privacy'

import { createMemoryBus } from '../../features/memory-bus.js'
import { visibleScopes, isVisible, scopeOf } from '../../features/memory-scope.js'

export { visibleScopes, isVisible, scopeOf }

export default {
  id: ID,
  name: '记忆分层',
  version: '1.0.0',
  api: 1,
  description: '移植自 dsh-qq：私聊里说的事只在私聊可见，群里怎么套也拿不到',
  panel: 'panel.js',
  tab: 'memory',
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
    // 记忆总线：本模块里所有「记一条 / 翻记忆」都从这里走（1.3.48 起）。
    // 总线底下是主库，作用域口径就是本模块导出的那三个纯函数。
    // store 惰性解析：setup 时 memory 模块可能还没启动完，不能把 null 烧死在闭包里
    const busStore = () => { try { return api.use('memory') || null } catch { return null } }
    const bus = { add: (o) => createMemoryBus({ store: busStore(), log: api.log }).add(o) }

    // 1.3.48：本模块自己的 scoped.json 平行库连同 add/load/save 全部删除。
    // 它在 P0-4 就已停用（存量迁移进主库后文件改名备份），但代码一直留着——
    // 结果每个新记忆源都要纠结「写到哪边」。现在只有一条路：走记忆总线（features/memory-bus.js），
    // 总线底下是主库（features/memory.js），作用域口径由本模块导出的 scopeOf/visibleScopes 提供。

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
          const liveMem = api.use('memory') || globalThis.qqHub?.modules?.use('memory')
          if (!liveMem?.add) return { ok: false, message: '主记忆库没在跑' }
          const finalScope = !scope || scope === 'auto'
            ? (api.settings().autoScope ? scopeOf(chat) : 'global')
            : scope
          try {
            // 走总线（1.3.48）：所有记忆写入口收拢到 features/memory-bus.js
            const r = liveMem.add({
              text: String(text || '').trim(),
              importance: Math.max(0, Math.min(1, Number(importance) || 0.6)),
              source: 'tool',
              chatId: chat?.chatId || finalScope,
              scope: finalScope,
            })
            if (r && r.ok === false) return r
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
      const q = req?.query || {}
      const scope = String(q.scope || '')
      const kind = String(q.kind || 'memory') // memory=主库记忆点 / profiles=人物小档案
      const cfg = api.settings()
      const preview = Boolean(cfg.previewPrivate)
      const mask = (m) => (preview || !String(m.scope).startsWith('private:') ? m : { ...m, text: '（私聊内容，面板不预览）' })
      // 查看、条数都以主记忆库为准（scoped.json 已迁移停用，永远查不出东西）
      const memory = api.use('memory') || globalThis.qqHub?.modules?.use('memory')
      if (kind === 'profiles') {
        const profs = (memory && typeof memory.profiles === 'function' ? memory.profiles() : []) || []
        const items = profs.filter((p) => !scope || String(p.scope || 'global') === scope).map(mask)
        return { ok: true, preview, items }
      }
      const items = (memory && typeof memory.list === 'function' ? memory.list() : []).filter((m) => !scope || String(m.scope || 'global') === scope).map(mask)
      return { ok: true, preview, items }
    })
    // 主记忆库按作用域清空（同样二次确认在前端做）
    api.route('/memory-privacy/clear-main', async (req) => {
      const q = req?.query?.scope || ''
      let body = {}
      if (!q) { try { body = await api.core.http.body(req) } catch (error) {} }
      const scope = String(q || body?.scope || '')
      if (!scope) return { ok: false, message: '要先说清哪个分区' }
      const memory = api.use('memory') || globalThis.qqHub?.modules?.use('memory')
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
      const out = { ok: true, total: 0, overrides, scopes: [], globalItems: [] }
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
    return { scopeOf, visibleScopes, isVisible }
  },
}
