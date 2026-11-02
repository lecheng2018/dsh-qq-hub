// 移植自 h-D-ACE/dsh-qq 的 auto-compact.js：预算守门员（Token Guardian）
//
// 为什么需要：DSH 默认要等上下文涨到窗口 80%（约 80 万 token）才 compact，
// 群聊长期累积后每一步的缓存读取费用都很贵。dsh-qq 的做法是「提前压制」：
// 统计会话消耗，超过阈值且会话空闲时，自动请求 DSH 把历史压成摘要。
//
// 这里按 aurabot 的模块规范重写：不碰任何核心文件，全部通过 api.* 完成：
// - 监听 DSH 会话事件（api.on('activity') + api.core.hub），记录每轮结束时间
// - api.core.hub.chatOfSession(sessionId) 拿到聊天，判断是否白名单内
// - 到达阈值且空闲 idle 秒后，调用 ask 走一次「压缩提示」，把结果落到模块数据目录，
//   并在上下文里注入「历史摘要」（api.context），从而实现等效的提前压缩
//
// 设计原则：默认关闭，主人在面板里打开才生效。

import { readJson, writeJson, dataDir } from '../../core/store.js'

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
    const stateFile = () => dataDir('state.json')
    const summaryFile = () => dataDir('summary.json')
    // sessionKey → { chars, lastAt, lastCompactAt, turns }
    let state = readJson(stateFile(), {})
    let summaries = readJson(summaryFile(), {}) // sessionKey → { text, at }
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
          for (const r of list) if (String(r.chatId) === String(chatId)) rows.push(`${r.who === 'self' ? '你' : '对方'}：${r.text}`)
        }
        return rows.join('\n').slice(-maxChars)
      } catch (error) { return '' }
    }

    /** 真正做一次提前压缩。 */
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
      const st = state[sessionKey] || {}
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
        const tokens = estimate(st.chars)
        if (tokens < Number(cfg.threshold)) continue
        if (now - Number(st.lastCompactAt || 0) < Number(cfg.cooldownMinutes) * 60_000) continue
        if (now - Number(st.lastAt || 0) < Number(cfg.idleSeconds) * 1000) continue
        let chat = null
        try { chat = hub.chatOfSession?.(key) } catch (error) {}
        // sessionKey 在某些路径下就是 chatId；两种形态都兼容
        const chatId = typeof chat === 'string' ? chat : (st.chatId || key)
        await compact(key, chat && typeof chat === 'object' ? chat : { chatId })
      }
    }

    api.on('activity', (a) => {
      if (!a || !a.chatId) return
      const key = String(a.chatId)
      const st = state[key] || { chars: 0, lastAt: 0, lastCompactAt: 0, turns: 0 }
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
      const rows = Object.entries(state).map(([chatId, st]) => ({
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
      const chatId = String(req?.query?.chatId || '')
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
          const st = state[String(chat.chatId)] || {}
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
