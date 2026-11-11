// 群黑话本模块（独立 optional 模块，按模块化重构结构落地）：
//   每日一次（凌晨 3 点后首个 tick）只读消费共享聊天流水，
//   发现候选词（纯统计）→ 模型判断是不是黑话 → 写进自己的黑话本 → 注入给群聊上下文。
//
// 为什么从 memory 模块拆出来（2026-11-08，主人报「现在不生效」的根因）：
//   1. **时序缺陷（主因）**：旧 learnGroupSlang 挂在 consolidate 天循环之后，而循环体内
//      「往日流水整理完即删」（hub.deleteChatLog）——04:00 那次处理的是昨天的日志，
//      调到它时流水已删，`all.length < 10` 静默返回；只有 16:00 处理「今天」的那次有机会，
//      一旦那个点插件不在跑，整天落空 → 实际长期不生效。
//   2. **冷却标记过宽**：slangLearned[day] 把「候选为空/模型失败」的群也标成学过，当天不再重试。
//   3. **无错误隔离**：模型调用没有按群隔离，一个群炸整天中断。
// 重构后：本模块自己管日程与数据（模块命名空间存储），按群隔离，成功/空候选才记 learned；
//   注入走自己的 context provider；面板路由原 URL 迁到本模块（客户端无感）。
//
// 边界：只学「词」（群在用什么梗/称呼），与「蒸馏群友」学「人」互补；数据全程本地。

import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from '../../core/store.js'
import { askModel } from '../../core/llm.js'
import { discoverSlangCandidates, buildSlangPrompt, parseSlangItems, renderSlangHint } from '../../features/slang-discover.js'

const SLANG_CAP = 12

/**
 * 黑话引擎工厂（依赖注入，测试用假件全测）。
 * @param {object} o
 * @param {() => object} o.config 全局配置
 * @param {() => object} o.loadState / o.saveState(state) 模块命名空间持久化
 * @param {() => string[]} o.chatLogDays / o.chatLogOf(day) 聊天流水（hub 公开面）
 * @param {(gid: string) => Promise<string>} [o.groupNameOf] 群名解析
 * @param {(dsh: object, opts: object) => Promise<string>} [o.askModelImpl] 模型调用（测试注入）
 * @param {object} [o.dsh] DSH 上下文
 */
export function createSlangEngine ({
  config, loadState, saveState, chatLogDays, chatLogOf,
  groupNameOf, askModelImpl = askModel, dsh = null, log = console, now = Date.now,
}) {
  let state = loadState() || {}
  if (!state.groups) state.groups = {}
  if (!state.learned) state.learned = {}

  const cfgOf = () => {
    const cfg = config() || {}
    return {
      enabled: cfg.enabled !== false && cfg.memory?.slang === true, // 默认关（面板开关）
      model: cfg.memory?.distillModel || { provider: '', model: '' }, // 与蒸馏同款低成本模型位
    }
  }

  const bookOf = (gid) => state.groups[String(gid)] || []
  const allGroups = () => ({ ...state.groups })

  /** 合并写入：同词更新解释，最多 SLANG_CAP 条（新的在前）。 */
  function putBook (gid, items) {
    const id = String(gid)
    const old = state.groups[id] || []
    const byWord = new Map()
    for (const it of items || []) {
      const w = String(it.word || '').trim()
      const m = String(it.meaning || '').trim()
      if (!w || !m) continue
      byWord.set(w, { id: randomUUID().slice(0, 8), word: w, meaning: m, at: now() })
    }
    for (const o of old) if (!byWord.has(o.word)) byWord.set(o.word, o)
    state.groups[id] = [...byWord.values()].sort((a, b) => b.at - a.at).slice(0, SLANG_CAP)
    saveState(state)
    return state.groups[id]
  }

  function removeItem (gid, itemId) {
    const list = state.groups[String(gid)] || []
    const next = list.filter((x) => String(x.id) !== String(itemId))
    if (next.length === list.length) return false
    state.groups[String(gid)] = next
    saveState(state)
    return true
  }

  function markLearned (day, gid) {
    const arr = state.learned[day] || []
    if (!arr.includes(String(gid))) {
      state.learned[day] = [...arr, String(gid)].slice(-200)
      saveState(state)
    }
  }

  /** 模型配置：memory.distillModel 配了就走它（与蒸馏共用低成本模型位），留空跟随主模型。 */
  function withModel (cfg) {
    const model = cfgOf().model || {}
    return { ...cfg, model: { ...(cfg.model || {}), ...model } }
  }

  /** 学一天：dayKey 形如 '2026-11-07'（hub.chatLogOf 的键）。按群隔离，成功/空候选才记 learned。 */
  async function learnDay (day) {
    const dc = cfgOf()
    if (!dc.enabled) return { ok: false, message: '群黑话开关关着（memory.slang）' }
    const all = chatLogOf?.(day) || []
    if (all.length < 10) return { ok: false, message: `那天流水只有 ${all.length} 行（≥10 才统计）` }
    const byGroup = new Map()
    for (const l of all) {
      if (!String(l.chatId || '').startsWith('group:')) continue
      if (!byGroup.has(l.chatId)) byGroup.set(l.chatId, [])
      byGroup.get(l.chatId).push(l)
    }
    const results = []
    for (const [chatId, lines] of byGroup) {
      const gid = chatId.slice(6)
      try {
        const cands = discoverSlangCandidates(lines)
        if (!cands.length) {
          markLearned(day, gid) // 真没候选：如实记学过（无候选）
          results.push({ gid, ok: true, learned: 0, note: '无候选' })
          continue
        }
        if ((state.learned[day] || []).includes(gid)) { results.push({ gid, ok: true, learned: 0, note: '当天已学' }); continue }
        let groupName = gid
        try { groupName = (await groupNameOf?.(gid)) || gid } catch {}
        const prompt = buildSlangPrompt({ groupName, cands })
        const out = await askModelImpl(dsh, { cfg: withModel(config()), ...prompt, maxTokens: 500 })
        const items = parseSlangItems(out)
        if (!items.length) {
          markLearned(day, gid) // 模型判定全是常用词：如实记学过
          results.push({ gid, ok: true, learned: 0, note: '模型判定无可记' })
          continue
        }
        const saved = putBook(gid, items)
        markLearned(day, gid)
        results.push({ gid, ok: true, learned: saved.length })
        log.info?.(`群黑话（${groupName}）：学到 ${saved.length} 个词（${saved.map((x) => x.word).join('、')}）`)
      } catch (error) {
        // 失败的群**不记 learned**（明天还能再学），也不中断其他群
        results.push({ gid, ok: false, error: String(error?.message || error) })
        log.warn?.(`群黑话（${gid}）学习失败：`, error.message)
      }
    }
    return { ok: true, results }
  }

  const dayKeyOf = (t) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  /** 每日 tick（模块每分钟调）：03 点后当日首跑；学「昨天」的完整流水，
   *  昨天流水不足（模块中途启用等）就退而学今天的。 */
  function tick ({ onLearned } = {}) {
    const dc = cfgOf()
    if (!dc.enabled) return
    const t = now()
    const day = new Date(t).toDateString()
    if (state.lastRunDay === day) return
    if (new Date(t).getHours() < 3) return
    state = { ...state, lastRunDay: day }
    saveState(state)
    const yesterday = dayKeyOf(t - 24 * 3600_000)
    const runDay = (chatLogOf?.(yesterday) || []).length >= 10 ? yesterday : dayKeyOf(t)
    Promise.resolve()
      .then(() => learnDay(runDay))
      .then((r) => { if (onLearned) onLearned(r) })
      .catch((error) => log.warn?.('群黑话每日学习失败：', error.message))
  }

  /** 注入文本（模块 context provider 用）。 */
  function hintFor (gid) {
    return renderSlangHint(bookOf(gid))
  }

  return { learnDay, tick, putBook, removeItem, bookOf, allGroups, hintFor, status: () => ({ lastRunDay: state.lastRunDay || '', groups: Object.keys(state.groups).length }) }
}

// 模块定义。黑话本迁移从 memory.slang()（遗留只读口）一次性搬入；学习不依赖 memory 模块。
export const slangModule = {
  id: 'slang',
  name: '群黑话本',
  version: '1.0.0',
  api: 1,
  description: '每天从群聊流水里提炼这个群在用的黑话/梗/圈内称呼，写进黑话本并在群聊里听懂就用。只学词，不学人（学人请用「蒸馏群友」）。',
  provides: ['group-slang'],
  tab: 'mood',
  files: ['features/slang-discover.js'],
  setup(api) {
    const stateFile = api.dataDir('book.json')
    // 遗留迁移：旧版黑话本存在 memory.json（memory.slang() 只读口），首启一次性搬进来
    try {
      const legacy = api.use('memory')?.slang?.() || []
      const existing = readJson(stateFile) || { groups: {}, learned: {} }
      if (!existing.groups || !Object.keys(existing.groups).length) {
        const groups = {}
        for (const g of legacy) if (g?.gid && Array.isArray(g.list) && g.list.length) groups[String(g.gid)] = g.list
        if (Object.keys(groups).length) {
          writeJson(stateFile, { groups, learned: existing.learned || {} })
          api.log.info?.(`群黑话本迁移完成：${Object.keys(groups).length} 个群（自 memory.json）`)
        }
      }
    } catch (error) { api.log.debug?.('群黑话本迁移跳过：', error.message) }

    const engine = createSlangEngine({
      config: api.config,
      loadState: () => { try { return readJson(stateFile) } catch { return null } },
      saveState: (s) => { try { writeJson(stateFile, s) } catch (e) { api.log.warn?.('黑话本保存失败：', e.message) } },
      chatLogDays: () => api.core.hub.chatLogDays?.() || [],
      chatLogOf: (day) => api.core.hub.chatLogOf?.(day) || [],
      groupNameOf: async (gid) => {
        const name = api.core.hub.groupNames?.get?.(String(gid))
        return name && name !== gid ? name : gid
      },
      askModelImpl: askModel,
      dsh: api.dsh,
      log: api.log,
    })

    // 注入：群聊上下文里带黑话本（模块自己的 context provider，不进 memory 的 contextFor）
    api.context(({ chat }) => (chat.kind === 'group' ? engine.hintFor(chat.groupId) : ''))

    // 每日学习（03 点后当日首跑，学昨天/今天的完整流水）
    api.every(60_000, () => engine.tick(), '群黑话每日学习')

    // 面板路由（URL 与搬迁前一致，客户端无感）
    const http = api.core.http
    api.route('/slang', async () => {
      const cfg = api.config()
      const allow = (cfg.allow?.groups || []).map(String)
      const book = engine.allGroups()
      const groups = []
      for (const gid of [...new Set([...Object.keys(book), ...allow])]) {
        const name = await safeGroupName(api, gid)
        groups.push({ gid, name: name && name !== gid ? name : '', list: book[String(gid)] || [] })
      }
      return { ok: true, groups }
    })
    api.route('/slang/save', async (req) => {
      const b = await http.body(req)
      const gid = String(b.gid || '').trim()
      if (!gid) return { ok: false, message: '要先说清哪个群' }
      const list = Array.isArray(b.list) ? b.list : String(b.text || '').split('\n')
      // 面板按「词=意思」一行一条编辑
      const items = list.map((x) => {
        if (x && typeof x === 'object') return { word: x.word, meaning: x.meaning }
        const t = String(x || '').trim()
        const m = t.match(/^(.+?)[=＝:：](.+)$/)
        return m ? { word: m[1].trim(), meaning: m[2].trim() } : null
      }).filter(Boolean)
      const saved = engine.putBook(gid, items)
      return { ok: true, message: `黑话本已保存（${saved.length} 条）`, list: saved }
    })
    api.route('/slang/delete', async (req) => {
      const b = await http.body(req)
      const gid = String(b.gid || '').trim()
      const ok = engine.removeItem(gid, b.id)
      return { ok, message: ok ? '删掉了' : '没找到这条' }
    })
    api.route('/slang/status', async () => ({ ok: true, ...engine.status() }))

    async function safeGroupName (api2, gid) {
      try {
        const n = await api2.core.hub.groupName?.(gid)
        return n && n !== gid ? n : ''
      } catch { return '' }
    }

    return {
      status: () => engine.status(),
      book: (gid) => engine.bookOf(gid),
      hintFor: (gid) => engine.hintFor(gid),
    }
  },
}

export default slangModule
