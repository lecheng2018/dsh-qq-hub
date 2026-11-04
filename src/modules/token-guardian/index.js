// 移植自 h-D-ACE/dsh-qq 的 auto-compact.js：预算守门员（Token Guardian）
//
// 为什么需要：DSH 默认要等上下文涨到窗口 80%（约 80 万 token）才 compact，
// 群聊长期累积后每一步的缓存读取费用都很贵。dsh-qq 的做法是「提前压制」：
// 统计会话消耗，超过阈值且会话空闲时，自动请求 DSH 把历史压成摘要。
//
// 这里按 qq-hub 的模块规范重写：不碰任何核心文件，全部通过 api.* 完成：
// - 监听 DSH 会话事件（api.on('activity') + api.core.hub），记录每轮结束时间
// - api.core.hub.chatOfSession(sessionId) 拿到聊天，判断是否白名单内
// - 到达阈值且空闲 idle 秒后，调用 ask 走一次「压缩提示」，把结果落到模块数据目录，
//   并在上下文里注入「历史摘要」（api.context），从而实现等效的提前压缩
//
// 设计原则：默认关闭，主人在面板里打开才生效。

import { readJson, writeJson } from '../../core/store.js'

const ID = 'token-guardian'

export default {
  id: ID,
  name: '预算守门员',
  version: '1.0.0',
  api: 1,
  description: '移植自 dsh-qq：会话 token 涨太多时提前压缩历史，省下缓存读取的钱',
  panel: 'panel.js',
  tab: 'model',
  defaults: {
    enabled: false,
    /** 触发阈值（token 估算，按字符数 / 3 粗算） */
    threshold: 300000,
    /** 空闲多少秒后压缩，避免打断正在进行的对话 */
    idleSeconds: 20,
    /** 两次压缩之间的最小间隔（分钟） */
    cooldownMinutes: 120,
    /** 摘要最多保留多少字 */
    summaryMaxChars: 1200,
  },
  settings: [
    { key: 'enabled', label: '启用提前压缩', type: 'switch', hint: '关着的时候完全不动，按 DSH 默认行为走' },
    { key: 'threshold', label: '触发阈值（token）', type: 'number', min: 20000, max: 2000000, step: 10000, hint: '估算超过这个数就准备压缩。dsh-qq 默认 30 万' },
    { key: 'idleSeconds', label: '空闲多久后压缩（秒）', type: 'number', min: 5, max: 600, step: 5, hint: '正在聊天时不会打断' },
    { key: 'cooldownMinutes', label: '两次压缩最小间隔（分钟）', type: 'number', min: 10, max: 1440, step: 10 },
    { key: 'summaryMaxChars', label: '摘要最大字数', type: 'number', min: 200, max: 4000, step: 100 },
  ],
  setup(api) {
    const stateFile = () => api.dataDir('state.json')
    const summaryFile = () => api.dataDir('summary.json')
    /**
     * 只留「值是正经对象」的条目。老版本或异常退出可能把 null / 字符串写进 JSON，
     * 读回来之后 Object.entries 会给出 null，estimate(st.chars) 直接抛
     * "Cannot read properties of null (reading 'chars')"，把整个面板搞挂。
     */
    const cleanMap = (raw) => {
      const out = {}
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v
      }
      return out
    }
    // sessionKey → { chars, lastAt, lastCompactAt, turns }
    let state = cleanMap(readJson(stateFile(), {}))
    let summaries = cleanMap(readJson(summaryFile(), {})) // sessionKey → { text, at }
    let timer = null

    const persist = () => { try { writeJson(stateFile(), state) } catch (error) { api.log.warn('保存状态失败：', error.message) } }
    const persistSummary = () => { try { writeJson(summaryFile(), summaries) } catch (error) { api.log.warn('保存摘要失败：', error.message) } }

    /** 一次会话大概占多少 token：中文 1 字≈1 token，英文 4 字符≈1 token，粗算按 1.2 字符/token。 */
    const estimate = (chars) => Math.round(Number(chars || 0) / 1.2)

    /** 把最近聊天流水拼成一段供压缩用的原文（有上限）。 */
    function recentTranscript(hub, chatId, maxChars = 12000) {
      try {
        const days = hub.chatLogDays ? hub.chatLogDays() : []
        if (!days.length) return ''
        const rows = []
        for (let i = days.length - 1; i >= 0 && rows.join('').length < maxChars * 2; i--) {
          const list = hub.chatLogOf ? hub.chatLogOf(days[i]) : []
          // chatlog 里 bot 自己的 who 是 'bot'（不是 'self'）：判错了会让摘要里全是「对方」，
          // 分不清哪句是她说的，摘要质量直接废掉一半。
          for (const r of list) if (String(r.chatId) === String(chatId)) rows.push(`${(r.who === 'bot' || r.who === 'self') ? '你' : '对方'}：${r.text}`)
        }
        return rows.join('\n').slice(-maxChars)
      } catch (error) { return '' }
    }

    /** 真正做一次提前压缩。
     * 流程：把最近聊天流水压成摘要 → 存起来由 api.context() 常驻注入 →
     *       调 hub.resetChat() 归档旧会话、开新会话（历史实打实变小，不是只贴摘要）。
     * 摘要带过去，新会话开场就知道之前聊了什么 —— 「压缩」而不是「清空」。 */
    async function compact(sessionKey, chat) {
      const cfg = api.settings()
      const hub = api.core.hub
      const chatId = chat?.chatId || ''
      const transcript = chatId ? recentTranscript(hub, chatId) : ''
      if (!transcript) { api.log.debug(`${ID}：${chatId} 没有聊天流水，跳过压缩`); return false }
      let text = ''
      try {
        text = await api.ask({
          system: '你是「大肥鱼」的记忆整理助手。把下面这段聊天压缩成一份供后续对话参考的摘要：'
            + '保留人物、关系、约定、重要事实、正在聊的话题和她的态度；不要评价、不要编造、不要加标题。',
          text: transcript,
          maxTokens: Math.max(400, Math.min(2000, Math.round(cfg.summaryMaxChars / 1.2))),
        })
      } catch (error) {
        api.log.warn(`${ID}：压缩请求失败（${error.message}），下次再试`)
        return false
      }
      const body = String(text || '').trim().slice(0, cfg.summaryMaxChars)
      if (!body) return false
      summaries[sessionKey] = { text: body, at: Date.now(), chatId }
      persistSummary()
      // 关键一步：归档旧会话、换新会话 —— 旧历史实打实退出上下文，
      // 摘要由 api.context() 在新会话里继续提供（7 天内有效）。
      // 没有 QQ 会话的（理论不该发生）跳过重置，只留摘要。
      if (chatId) {
        try {
          if (typeof hub.resetChat === 'function' && hub.resetChat(chatId)) {
            api.log.info(`${ID}：${chatId} 旧会话已归档，新会话由摘要续接`)
          } else {
            api.log.debug(`${ID}：${chatId} 无可重置的会话（可能还没建过），只留摘要`)
          }
        } catch (error) {
          api.log.warn(`${ID}：重置会话失败（${error.message}），摘要仍保留`)
        }
      }
      const st = state[sessionKey] && typeof state[sessionKey] === 'object' ? state[sessionKey] : {}
      // 压缩完相当于把历史折成摘要，把估算值重置成摘要本身的规模
      st.chars = Math.round(body.length * 1.2)
      st.lastCompactAt = Date.now()
      st.compacts = (st.compacts || 0) + 1
      state[sessionKey] = st
      persist()
      api.log.info(`${ID}：${chatId} 提前压缩完成，摘要 ${body.length} 字（第 ${st.compacts} 次）`)
      api.emit('token-guardian/compacted', { chatId, chars: body.length })
      return true
    }

    /** 空闲检查：到了阈值、过了冷却、会话闲下来了就压。 */
    async function tickOnce() {
      const cfg = api.settings()
      if (!cfg.enabled) return
      const hub = api.core.hub
      const now = Date.now()
      for (const [key, st] of Object.entries(state)) {
        if (!st || typeof st !== 'object') { delete state[key]; continue }
        const tokens = estimate(st.chars)
        if (tokens < Number(cfg.threshold)) continue
        if (now - Number(st.lastCompactAt || 0) < Number(cfg.cooldownMinutes) * 60_000) continue
        if (now - Number(st.lastAt || 0) < Number(cfg.idleSeconds) * 1000) continue
        // state 的 key 就是 chatId（'activity' 里直接拿 a.chatId 当 key），直接用，
        // **不要拿 chatId 去问 hub.chatOfSession()** —— 那个函数要的是 sessionId，
        // 传 chatId 进去恒返回空串 ''，而 typeof '' === 'string' 成立，
        // 于是 chatId 被置空、compact() 因为「没有流水」直接 return false。
        // 这就是「自动压缩从来不工作」的真正原因（2026-11-04 排查）。
        let chatId = String(st.chatId || key || '')
        // 只有 key 不是 chatId 形态时才去反查（兼容历史上按 sessionId 记账的情况）
        if (!/^(group|private):/.test(chatId)) {
          try { const c = hub.chatOfSession?.(key); if (typeof c === 'string' && c) chatId = c } catch (error) {}
        }
        if (!chatId) continue
        await compact(key, { chatId })
      }
    }

    api.on('activity', (a) => {
      if (!a || !a.chatId) return
      const key = String(a.chatId)
      const st = state[key] && typeof state[key] === 'object' ? state[key] : { chars: 0, lastAt: 0, lastCompactAt: 0, turns: 0 }
      // 粗略累加：一条消息的正文 + 固定开销（角色、系统提示、工具清单都算在里）
      st.chars = Number(st.chars || 0) + String(a.text || '').length + 160
      st.lastAt = Date.now()
      if (a.kind === 'in') st.turns = Number(st.turns || 0) + 1
      state[key] = st
      // 落盘不用每条都写，攒够一定量或换天再写
      if (Number(st.turns || 0) % 5 === 0) persist()
    })

    timer = setInterval(() => { tickOnce().catch((error) => api.log.warn(`${ID} 检查出错：`, error.message)) }, 30_000)
    timer.unref?.()

    // 摘要以运行时上下文的形式交给她（每轮都在，篇幅固定，不会越滚越大）
    api.context(({ chat }) => {
      if (!chat || chat.kind === 'system') return ''
      const s = summaries[String(chat.chatId)]
      if (!s) return ''
      const age = Date.now() - Number(s.at || 0)
      if (age > 7 * 24 * 3600_000) return ''
      return `【更早聊天的摘要（${new Date(s.at).toLocaleString('zh-CN').slice(0, 16)}）】\n${s.text}`
    })

    api.rule(() => '如果上下文里出现了「更早聊天的摘要」，说明更早的历史已经被压成摘要：把摘要当自己的记忆使用，不要追问细节。')

    // 面板：各聊天用量一览 + 立即压缩一个聊天
    api.route('/token-guardian/status', () => {
      const rows = Object.entries(state)
        .filter(([, st]) => st && typeof st === 'object')
        .map(([chatId, st]) => ({
        chatId,
        chars: Number(st.chars || 0),
        tokens: estimate(st.chars),
        compacts: Number(st.compacts || 0),
        lastAt: Number(st.lastAt || 0),
        lastCompactAt: Number(st.lastCompactAt || 0),
        hasSummary: Boolean(summaries[chatId]),
      })).sort((a, b) => b.tokens - a.tokens).slice(0, 30)
      return { ok: true, threshold: api.settings().threshold, items: rows }
    })
    api.route('/token-guardian/compact-now', async (req) => {
      // 面板的 call(p, body) 会发 POST 把参数放 body；手输链接则是 GET 带 query。
      // 原来只读 query，面板点按钮永远拿不到 chatId，于是恒定回「要先说压缩哪个聊天」
      // （2026-11-04 主人反馈：手动点压一次也不行）。两边都要读。
      const q = req?.query?.chatId || ''
      let body = {}
      if (!q) { try { body = await api.core.http.body(req) } catch (error) { body = {} } }
      const chatId = String(q || body?.chatId || '')
      if (!chatId) return { ok: false, message: '要先说压缩哪个聊天' }
      const ok = await compact(chatId, { chatId })
      return ok ? { ok: true, message: '压缩好了' } : { ok: false, message: '这次没压成（没有聊天流水或请求失败，看日志）' }
    })

    api.tool(({ chat }) => {
      if (!chat || chat.kind === 'system') return []
      return api.defineTool({
        name: 'token_usage_now',
        description: '查看当前会话大概用了多少 token、有没有被提前压缩过。主人问「用了多少 token」时用。',
        properties: {},
        required: [],
        execute: async () => {
          const st = state[String(chat.chatId)] && typeof state[String(chat.chatId)] === 'object' ? state[String(chat.chatId)] : {}
          const cfg = api.settings()
          return {
            ok: true,
            message: `估算 ${estimate(st.chars)} token（阈值 ${cfg.threshold}），已提前压缩 ${st.compacts || 0} 次，`
              + `上次压缩 ${st.lastCompactAt ? new Date(st.lastCompactAt).toLocaleString('zh-CN') : '还没有'}`,
          }
        },
      })
    })

    api.onDispose(() => { if (timer) clearInterval(timer); persist() })

    return {
      compact,
      state: () => ({ ...state }),
      summaries: () => ({ ...summaries }),
      estimate,
    }
  },
}
