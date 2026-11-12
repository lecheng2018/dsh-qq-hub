// 群黑话本模块（独立 optional 模块，按模块化重构结构落地）：
//   凌晨 3 点后按来源游标补学保留期内的共享聊天流水，
//   发现候选词（纯统计）→ 模型判断是不是黑话 → 写进自己的黑话本 → 注入给群聊上下文。
//
// 为什么从 memory 模块拆出来（2026-11-08，主人报「现在不生效」的根因）：
//   1. **时序缺陷（主因）**：旧 learnGroupSlang 挂在 consolidate 天循环之后，而循环体内
//      「往日流水整理完即删」（hub.deleteChatLog）——04:00 那次处理的是昨天的日志，
//      调到它时流水已删，`all.length < 10` 静默返回；只有 16:00 处理「今天」的那次有机会，
//      一旦那个点插件不在跑，整天落空 → 实际长期不生效。
//   2. **冷却标记过宽**：slangLearned[day] 把「候选为空/模型失败」的群也标成学过，当天不再重试。
//   3. **无错误隔离**：模型调用没有按群隔离，一个群炸整天中断。
// 重构后：本模块自己管日程与数据（模块命名空间存储），按群隔离，成功/空候选才推进来源游标；
//   注入走自己的 context provider；面板路由原 URL 迁到本模块（客户端无感）。
//
// 边界：只学「词」（群在用什么梗/称呼），与「蒸馏群友」学「人」互补；数据全程本地。

import { randomUUID } from 'node:crypto'
import { readJsonRequired, writeJsonWithBackup } from '../../core/store.js'
import { askModel, withAbortTimeout, modelWithOverride } from '../../core/llm.js'
import { readChatLogSource, chatLogCursor, chatLogOffset } from '../../chat/chat-log.js'
import { discoverSlangCandidates, buildSlangPrompt, parseSlangItems, renderSlangHint } from '../../features/slang-discover.js'

const SLANG_CAP = 12

/**
 * 黑话引擎工厂（依赖注入，测试用假件全测）。
 * @param {object} o
 * @param {() => object} o.config 全局配置
 * @param {() => object} o.loadState / o.saveState(state) 模块命名空间持久化
 * @param {{ listDays: () => string[], readDay: (day: string) => object[] }} o.chatLog 共享聊天流水只读接口
 * @param {(gid: string) => Promise<string>} [o.groupNameOf] 群名解析
 * @param {(dsh: object, opts: object) => Promise<string>} [o.askModelImpl] 模型调用（测试注入）
 * @param {object} [o.dsh] DSH 上下文
 */
export function createSlangEngine ({
  config, loadState, saveState, chatLog, chatLogDays, chatLogOf,
  groupNameOf, askModelImpl = askModel, dsh = null, log = console, now = Date.now,
}) {
  let state = { groups: {}, learned: {}, sources: {}, ...(loadState() || {}) }
  const lifetime = new AbortController()
  const running = new Map()
  const sourceLog = chatLog || { listDays: () => chatLogDays?.() || [], readDay: (day) => chatLogOf?.(day) || [] }

  const cfgOf = () => {
    const cfg = config() || {}
    return {
      enabled: !lifetime.signal.aborted && cfg.enabled !== false && cfg.memory?.slang === true,
      model: cfg.memory?.distillModel || { provider: '', model: '' },
      timeoutMs: Math.max(1, Number(cfg.memory?.slangTimeoutMs) || 120_000),
    }
  }

  function commit (next) {
    lifetime.signal.throwIfAborted()
    saveState(next)
    state = next
  }

  const bookOf = (gid) => state.groups[String(gid)] || []
  const allGroups = () => ({ ...state.groups })

  function mergeBook (gid, items) {
    const byWord = new Map()
    for (const it of items || []) {
      const w = String(it.word || '').trim()
      const m = String(it.meaning || '').trim()
      if (!w || !m) continue
      byWord.set(w, { id: randomUUID().slice(0, 8), word: w, meaning: m, at: now() })
    }
    for (const old of bookOf(gid)) if (!byWord.has(old.word)) byWord.set(old.word, old)
    return [...byWord.values()].sort((a, b) => b.at - a.at).slice(0, SLANG_CAP)
  }

  function putBook (gid, items) {
    const list = mergeBook(gid, items)
    commit({ ...state, groups: { ...state.groups, [String(gid)]: list } })
    return list
  }

  function removeItem (gid, itemId) {
    const list = bookOf(gid)
    const next = list.filter((x) => String(x.id) !== String(itemId))
    if (next.length === list.length) return false
    commit({ ...state, groups: { ...state.groups, [String(gid)]: next } })
    return true
  }

  function withModel (cfg) {
    return { ...cfg, model: modelWithOverride(cfg.model, cfgOf().model) }
  }

  function learnDay (day) {
    if (running.has(day)) return running.get(day)
    const task = consumeDay(day).finally(() => running.delete(day))
    running.set(day, task)
    return task
  }

  async function consumeDay (day) {
    const dc = cfgOf()
    if (!dc.enabled) return { ok: false, message: '群黑话开关关着或模块已关闭' }
    let snapshot
    try { snapshot = readChatLogSource(sourceLog, day) } catch (error) { return { ok: false, message: error.message } }
    const all = snapshot.records
    const gids = new Set([
      ...all.filter((l) => String(l.chatId || '').startsWith('group:')).map((l) => l.chatId.slice(6)),
      ...Object.keys(state.sources[day] || {}),
    ])
    const results = []
    for (const gid of gids) {
      if (!cfgOf().enabled) break
      try {
        const offset = chatLogOffset(snapshot, state.sources[day]?.[gid])
        if (offset === all.length) {
          results.push({ gid, ok: true, learned: 0, note: '来源已学' })
          continue
        }
        const lines = all.slice(offset).filter((l) => l.chatId === `group:${gid}`)
        const cands = discoverSlangCandidates(lines)
        let items = []
        if (cands.length) {
          let groupName = gid
          try { groupName = (await groupNameOf?.(gid)) || gid } catch {}
          const prompt = buildSlangPrompt({ groupName, cands })
          const out = await withAbortTimeout(
            (signal) => askModelImpl(dsh, { cfg: withModel(config()), ...prompt, maxTokens: 500, signal }),
            dc.timeoutMs, '群黑话学习', lifetime.signal,
          )
          const raw = (String(out ?? '').match(/\[[\s\S]*\]/) || [String(out ?? '')])[0]
          if (!Array.isArray(JSON.parse(raw))) throw new Error('群黑话回包不是 JSON 数组')
          items = parseSlangItems(out)
        }
        if (!cfgOf().enabled) throw new Error('群黑话模块已关闭')
        const cursor = chatLogCursor(snapshot)
        chatLogOffset(readChatLogSource(sourceLog, day), cursor)
        const saved = items.length ? mergeBook(gid, items) : bookOf(gid)
        commit({
          ...state,
          groups: { ...state.groups, [gid]: saved },
          learned: { ...state.learned, [day]: [...new Set([...(state.learned[day] || []), gid])] },
          sources: { ...state.sources, [day]: { ...state.sources[day], [gid]: cursor } },
        })
        results.push({ gid, ok: true, learned: items.length, note: cands.length ? '' : '无候选' })
      } catch (error) {
        results.push({ gid, ok: false, error: String(error?.message || error) })
        log.warn?.(`群黑话（${gid}）学习失败：`, error.message)
      }
    }
    return { ok: !lifetime.signal.aborted, results }
  }

  const dayKeyOf = (t) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  let learning = false
  async function tick ({ onLearned } = {}) {
    if (!cfgOf().enabled || learning || new Date(now()).getHours() < 3) return
    learning = true
    try {
      const today = dayKeyOf(now())
      const yesterday = dayKeyOf(now() - 86400_000)
      let days = sourceLog.listDays().filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day < today)
      if (!days.length) days = [sourceLog.readDay(yesterday).length >= 10 ? yesterday : today]
      let ok = true
      for (const day of days.sort()) {
        const result = await learnDay(day)
        ok = ok && result.ok && (result.results || []).every((r) => r.ok)
        if (!cfgOf().enabled) break
        if (onLearned) await onLearned(result)
      }
      if (ok && cfgOf().enabled) commit({ ...state, lastRunDay: new Date(now()).toDateString() })
      return { ok }
    } catch (error) {
      log.warn?.('群黑话每日学习失败：', error.message)
      return { ok: false, message: error.message }
    } finally { learning = false }
  }

  function dispose () {
    lifetime.abort(new Error('群黑话模块已关闭'))
  }

  /** 注入文本（模块 context provider 用）。 */
  function hintFor (gid) {
    return renderSlangHint(bookOf(gid))
  }

  return { learnDay, tick, putBook, removeItem, bookOf, allGroups, hintFor, dispose, status: () => ({ lastRunDay: state.lastRunDay || '', groups: Object.keys(state.groups).length }) }
}

// 模块定义。黑话本迁移从 memory.slang()（遗留只读口）一次性搬入；学习不依赖 memory 模块。
export const slangModule = {
  id: 'slang',
  name: '群黑话本',
  version: '1.0.0',
  api: 1,
  description: '每天从群聊流水里提炼这个群在用的黑话/梗/圈内称呼，写进黑话本并在群聊里听懂就用。只学词，不学人（学人请用「蒸馏群友」）。',
  provides: ['group-slang'],
  tab: 'memory',
  files: ['features/slang-discover.js'],
  setup(api) {
    const stateFile = api.dataDir('book.json')
    const existing = readJsonRequired(stateFile, { fallback: () => ({ groups: {}, learned: {} }), validate: (value) => value && typeof value === 'object' && !Array.isArray(value), label: '群黑话本状态', onError: (error) => api.log.warn(error.message) })
    // 遗留迁移：旧版黑话本存在 memory.json（memory.slang() 只读口），首启一次性搬进来
    try {
      const legacy = api.use('memory')?.slang?.() || []
      if (!existing.groups || !Object.keys(existing.groups).length) {
        const groups = {}
        for (const g of legacy) if (g?.gid && Array.isArray(g.list) && g.list.length) groups[String(g.gid)] = g.list
        if (Object.keys(groups).length) {
          writeJsonWithBackup(stateFile, { groups, learned: existing.learned || {} }, { validate: (value) => value && typeof value === 'object' && !Array.isArray(value), label: '群黑话本状态', onError: (error) => api.log.warn(error.message) })
          api.log.info?.(`群黑话本迁移完成：${Object.keys(groups).length} 个群（自 memory.json）`)
        }
      }
    } catch (error) { api.log.debug?.('群黑话本迁移跳过：', error.message) }

    const engine = createSlangEngine({
      config: api.config,
      loadState: () => readJsonRequired(stateFile, {
        fallback: () => ({ groups: {}, learned: {}, sources: {} }),
        validate: (value) => value && typeof value === 'object' && !Array.isArray(value),
        label: '群黑话本状态', onError: (error) => api.log.warn(error.message),
      }),
      saveState: (state) => writeJsonWithBackup(stateFile, state, {
        validate: (value) => value && typeof value === 'object' && !Array.isArray(value),
        label: '群黑话本状态', onError: (error) => api.log.warn(error.message),
      }),
      chatLog: api.core.chatLog,
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

    // 03 点后按来源游标补学，失败的群下次继续。
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
      dispose: () => engine.dispose(),
    }
  },
}

export default slangModule
