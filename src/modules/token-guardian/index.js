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
    /** 触发阈值（token 估算，真实 usage 不可用时按字符数 × 1.4 粗算） */
    threshold: 300000,
    /** 空闲多少秒后压缩，避免打断正在进行的对话 */
    idleSeconds: 20,
    /** 两次压缩之间的最小间隔（分钟） */
    cooldownMinutes: 120,
    /** 摘要最多保留多少字 */
    summaryMaxChars: 1200,
    /** 单次摘要模型请求上限；超时中止并释放压缩锁 */
    askTimeoutSeconds: 90,
  },
  settings: [
    { key: 'enabled', label: '启用提前压缩', type: 'switch', hint: '关着的时候完全不动，按 DSH 默认行为走' },
    { key: 'threshold', label: '触发阈值（token）', type: 'number', min: 20000, max: 2000000, step: 10000, hint: '估算超过这个数就准备压缩。dsh-qq 默认 30 万' },
    { key: 'idleSeconds', label: '空闲多久后压缩（秒）', type: 'number', min: 5, max: 600, step: 5, hint: '正在聊天时不会打断' },
    { key: 'cooldownMinutes', label: '两次压缩最小间隔（分钟）', type: 'number', min: 10, max: 1440, step: 10 },
    { key: 'summaryMaxChars', label: '摘要最大字数', type: 'number', min: 200, max: 4000, step: 100 },
    { key: 'askTimeoutSeconds', label: '摘要请求超时（秒）', type: 'number', min: 30, max: 300, step: 30, hint: '超时后取消请求并释放压缩锁；失败会指数退避，不会每 30 秒重试' },
  ],
  setup(api) {
    const stateFile = () => api.dataDir('state.json')
    // 每个聊天最近一次请求的**真实上下文**（input+cacheRead+cacheWrite，厂商上报）。
    // 只在内存里，不落盘不开关 —— 压缩判定靠它才准（字符估算差 5~9 倍，该压不压）。
    // 重启后为空，退回字符估算，等新流量进来自然恢复。
    const latestByChat = new Map()
    api.on('session/usage', (u) => {
      try {
        if (!u || !u.chatId || !u.usage) return
        const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
        const ctxNow = n(u.usage.uncachedInputTokens) + n(u.usage.cacheReadTokens) + n(u.usage.cacheWriteTokens)
        if (ctxNow <= 0) return
        // 入向 0/骤降的小请求（标题生成、摘要）不该覆盖大值：上下文不会一轮掉一半
        const prevTok = Number(latestByChat.get(String(u.chatId))?.tokens) || 0
        if (prevTok > 0 && ctxNow < prevTok * 0.6) return
        latestByChat.set(String(u.chatId), { tokens: ctxNow, at: Date.now() })
      } catch (error) {}
    })
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
    // chatId → { chars, lastAt, lastCompactAt, turns }（1.3.10 起两处 key 都统一为 chatId）
    let state = cleanMap(readJson(stateFile(), {}))
    let summaries = cleanMap(readJson(summaryFile(), {})) // chatId → { text, at }
    let timer = null
    let flushTimer = null

    const persist = () => { try { writeJson(stateFile(), state) } catch (error) { api.log.warn('保存状态失败：', error.message) } }
    const persistSummary = () => { try { writeJson(summaryFile(), summaries) } catch (error) { api.log.warn('保存摘要失败：', error.message) } }

    /** 一次会话大概占多少 token：中文 1 字≈1.4 token（DeepSeek tokenizer 实测 1.3~1.5），
     * 旧口径 chars/1.2 会低估三成（上下文 80k 按成 60k，压缩该触发不触发，2026-11-05 复盘）。 */
    const CHARS_TO_TOKEN = 1.4
    const estimate = (chars) => Math.round(Number(chars || 0) * CHARS_TO_TOKEN)
    const RETRY_BACKOFFS = [30_000, 60_000, 300_000, 900_000, 1800_000]

    function noteFailure(sessionKey, message) {
      const st = state[sessionKey] && typeof state[sessionKey] === 'object' ? state[sessionKey] : {}
      const now = Date.now()
      st.failures = Number(st.failures || 0) + 1
      st.lastAttemptAt = now
      st.lastError = String(message || '未知错误').slice(0, 160)
      st.nextAttemptAt = now + RETRY_BACKOFFS[Math.min(st.failures - 1, RETRY_BACKOFFS.length - 1)]
      state[sessionKey] = st
      persist()
    }

    /** 把最近聊天流水拼成一段供压缩用的原文（有上限）。
     * 开头带上上一份摘要（若有）：连续压缩时，第一次压缩摘掉的那段聊天只存在于摘要里，
     * chatlog 早就翻不到了 —— 不带它，第二次压缩就会把更早的对话彻底丢掉（2026-11-05 排查）。 */
    function recentTranscript(hub, chatId, maxChars = 12000) {
      try {
        const prev = summaries[chatId]
        const head = prev && prev.text ? `【更早聊天的摘要（${new Date(prev.at).toLocaleString('zh-CN').slice(0, 16)}）】\n${prev.text}\n\n【以下是之后新说的】\n` : ''
        const days = hub.chatLogDays ? hub.chatLogDays() : []
        if (!days.length) return head.trim() ? head : ''
        const rows = []
        for (let i = days.length - 1; i >= 0 && rows.join('').length < maxChars * 2; i--) {
          const list = hub.chatLogOf ? hub.chatLogOf(days[i]) : []
          // chatlog 里 bot 自己的 who 是 'bot'（不是 'self'）：判错了会让摘要里全是「对方」，
          // 分不清哪句是她说的，摘要质量直接废掉一半。
          for (const r of list) if (String(r.chatId) === String(chatId)) rows.push(`${(r.who === 'bot' || r.who === 'self') ? '你' : '对方'}：${r.text}`)
        }
        // 摘要头固定占预算，原文吃剩下的额度 —— 总输入仍然有上限，不会越压越大
        const body = rows.join('\n').slice(-Math.max(2000, maxChars - head.length))
        return head + body
      } catch (error) {
        const prev = summaries[chatId]
        return prev && prev.text ? `【更早聊天的摘要】\n${prev.text}` : ''
      }
    }

    /** 真正做一次提前压缩。
     * 流程：把最近聊天流水压成摘要 → 存起来由 api.context() 常驻注入 →
     *       调 hub.resetChat() 归档旧会话、开新会话（历史实打实变小，不是只贴摘要）。
     * 摘要带过去，新会话开场就知道之前聊了什么 —— 「压缩」而不是「清空」。 */
    // sessionKey 实际就是 chatId（state/summaries 两处 key 均已统一为 chatId）
    // 每 chatId 一把并发锁：tickOnce 每 30 秒轮询、面板「现在压一次」随时可点，
    // 同一个聊天两个压缩同时跑就是双 resetChat + 双摘要。锁按 chatId 分开，不同聊天互不挡。
    const compactBusy = new Set()
    async function compact(sessionKey, chat, meta = {}) {
      const cfg = api.settings()
      const hub = api.core.hub
      const chatId = chat?.chatId || ''
      if (chatId) {
        if (compactBusy.has(chatId)) {
          api.log.debug(`${ID}：${chatId} 已经在压缩中，这次跳过`)
          return { ok: false, reason: 'busy', message: '这个聊天正在压缩，别急着再点' }
        }
        compactBusy.add(chatId)
      }
      try {
        return await doCompact(sessionKey, chat, meta)
      } finally {
        if (chatId) compactBusy.delete(chatId)
      }
    }

    async function doCompact(sessionKey, chat, meta = {}) {
      const cfg = api.settings()
      const hub = api.core.hub
      const chatId = chat?.chatId || ''
      const transcript = chatId ? recentTranscript(hub, chatId) : ''
      // 返回结构：ok + reason（让面板能说清「为什么没压成」，而不是一句笼统的「看日志」）
      if (!transcript) {
        api.log.debug(`${ID}：${chatId} 没有聊天流水，跳过压缩`)
        return { ok: false, reason: 'no-transcript', message: '还没聊过，没有可压缩的流水' }
      }
      let text = ''
      // 摘要用这个聊天正在用的模型写（不是全局默认）：群里指定的模型和摘要口径要一致（P1-5）。
      // 拿不到（没配 chatModels/老入口）就退回全局默认，行为和以前一样。
      let askOpts = {}
      try {
        const t = await hub.resolveTarget?.(chat)
        if (t && t.provider && t.model) askOpts = { provider: t.provider, model: t.model }
      } catch (error) { api.log.debug(`${ID}：拿聊天模型失败，摘要用默认模型（${error.message}）`) }
      const controller = new AbortController()
      const timeoutSeconds = Math.max(0.01, Number(cfg.askTimeoutSeconds) || 90)
      let askTimer = null
      const timeout = new Promise((_, reject) => {
        askTimer = setTimeout(() => {
          const error = new Error(`压缩请求超过 ${timeoutSeconds} 秒，已中止`)
          error.turnTimedOut = true
          controller.abort(error)
          reject(error)
        }, timeoutSeconds * 1000)
        askTimer.unref?.()
      })
      try {
        text = await Promise.race([api.ask({
          // 摘要口径对齐 dsh-compaction-basic 的 checkpoint 规则：旧摘要是 PRIOR checkpoint，
          // 要合并成一份，不是照抄；最后一条发言按原意保留；分清谁说的；一段话，别列表。
          system: '你是「大肥鱼」的记忆整理助手。把下面的内容压缩成一份供后续对话参考的摘要：'
            + '如果开头带【更早聊天的摘要】，那是上一份检查点：保留仍然成立的事实、丢掉已经过时的、把新内容并进去，输出**一份**合并后的摘要，不要照抄也不要分两截。'
            + '保留人物、关系、约定、重要事实、正在聊的话题和她的态度；最后一条用户发言按原意保留，别只写成「聊了某事」；'
            + '每句话写清是谁说的（用「你」和「对方」），分不清的就标「有人」；'
            + '整段连贯的文字，不要 Markdown 列表、不要分节、不要小标题；不要评价、不要编造、不要加标题。',
          text: transcript,
          maxTokens: Math.max(400, Math.min(2000, Math.round(cfg.summaryMaxChars * 1.4))),
          signal: controller.signal,
          ...askOpts,
        }), timeout])
      } catch (error) {
        const msg = String(error?.message || error)
        noteFailure(sessionKey, msg)
        if (error?.turnTimedOut) {
          api.log.warn(`${ID}：${msg}，稍后按退避时间重试`)
          return { ok: false, reason: 'timeout', message: msg }
        }
        // 限流最容易被误当成「功能坏了」：明确告诉她切模型或等重置，别让她以为是代码问题
        if (/429|rate.?limit|频率限制|quota|限额/i.test(msg)) {
          api.log.warn(`${ID}：压缩请求被限流（${msg.slice(0, 120)}），额度恢复后再试`)
          return { ok: false, reason: 'rate-limited', message: '模型额度用完了（429 限流），额度恢复后再试或换个模型' }
        }
        api.log.warn(`${ID}：压缩请求失败（${msg}），下次再试`)
        return { ok: false, reason: 'ask-failed', message: '模型调用失败：' + msg.slice(0, 80) }
      } finally {
        if (askTimer) clearTimeout(askTimer)
      }
      const body = String(text || '').trim().slice(0, cfg.summaryMaxChars)
      if (!body) {
        noteFailure(sessionKey, '模型没给出可用的摘要')
        return { ok: false, reason: 'empty-summary', message: '模型没给出可用的摘要' }
      }
      // 摘要文本一变，DSH 会把它作为新快照追加进当前历史（旧块不删）。
      // 所以必须「先重置会话，再落摘要」：resetChat 成功后新会话历史里只有最新这一份摘要；
      // resetChat 失败（没 QQ 会话/归档失败）就不更新摘要 —— 宁可不压，也不让同一段历史里
      // 同时躺着 v1/v2/v3 三份「更早聊天的摘要」让模型自己猜哪份新（P0-6）。
      let resetOk = false
      if (chatId) {
        try {
          resetOk = typeof hub.resetChat === 'function' && hub.resetChat(chatId)
          if (resetOk) api.log.info(`${ID}：${chatId} 旧会话已归档，新会话由摘要续接`)
          else api.log.debug(`${ID}：${chatId} 无可重置的会话（可能还没建过），跳过摘要更新`)
        } catch (error) {
          api.log.warn(`${ID}：重置会话失败（${error.message}），摘要仍保留旧版`)
        }
      }
      if (!resetOk) {
        // 没清场就不换摘要：旧摘要继续用，等下次压缩成功一起换。
        // no-reset 多是暂时性失败（会话正被归档/还没建），10 分钟重试；
        // 模型请求失败使用 noteFailure 的指数退避，成功后才记录完整压缩冷却。
        const st0 = state[sessionKey] && typeof state[sessionKey] === 'object' ? state[sessionKey] : {}
        st0.lastCompactAt = Date.now() - (Number(cfg.cooldownMinutes) * 60_000 - 10 * 60_000)
        state[sessionKey] = st0
        persist()
        return { ok: false, reason: 'no-reset', message: '旧会话没归档成功，摘要保持原样（10 分钟内会自动重试）' }
      }
      // 摘要写回 chatlog（她自己的名字记一笔，who 用 'bot'）：
      //   1. chatlog 保留 14 天，而摘要 7 天就过期 —— 过期后她对这些对话失忆，且没有任何机制重建；
      //      写回之后，下次压缩的输入天然带上旧摘要，连续压缩也不会再丢更早的对话（和 recentTranscript 的摘要头双保险）。
      //   2. 只在会话真的换了（resetOk）时写，避免旧会话里堆两份。
      if (chatId && typeof hub.logChat === 'function') {
        try {
          hub.logChat(chatId, 'bot', `【更早聊天的摘要（${new Date().toLocaleString('zh-CN').slice(0, 16)}）】\n${body}`)
        } catch (error) { api.log.debug(`${ID}：摘要写回聊天流水失败（不影响压缩）：`, error.message) }
      }
      summaries[sessionKey] = { text: body, at: Date.now(), chatId }
      persistSummary()
      const st = state[sessionKey] && typeof state[sessionKey] === 'object' ? state[sessionKey] : {}
      // chars 永远只存真实字符数；estimate() 是唯一的 token 换算点
      st.chars = body.length
      st.lastCompactAt = Date.now()
      st.compacts = (st.compacts || 0) + 1
      st.failures = 0
      st.lastError = ''
      st.nextAttemptAt = 0
      state[sessionKey] = st
      persist()
      api.log.info(`${ID}：${chatId} 提前压缩完成，摘要 ${body.length} 字（第 ${st.compacts} 次）${meta.measured ? `，触发时真实上下文 ${Math.round(meta.tokens / 1000)}k token` : `，按字符估算 ${estimate(meta.tokens ? meta.tokens / CHARS_TO_TOKEN : st.chars)} token`}`)
      latestByChat.delete(String(chatId || ''))
      api.emit('token-guardian/compacted', { chatId, chars: body.length })
      return { ok: true, chars: body.length, compacts: st.compacts }
    }

    /** 摘要里会带【更早聊天的摘要】标记，不该被当成正常聊天再提炼成长期记忆 —— 标记开头的行给整理模块跳过用。 */
    const isSummaryLog = (text) => /^【更早聊天的摘要/.test(String(text || ''))

    /** 空闲检查：到了阈值、过了冷却、会话闲下来了就压。 */
    async function tickOnce() {
      const cfg = api.settings()
      if (!cfg.enabled) return
      const hub = api.core.hub
      const now = Date.now()
      for (const [key, st] of Object.entries(state)) {
        if (!st || typeof st !== 'object') { delete state[key]; continue }
        // 优先用真实 usage（内存里的最新一次请求上下文），没有才退回字符估算
        let tokens = estimate(st.chars)
        let measured = false
        try {
          const real = latestByChat.get(key)
          if (real && Number.isFinite(real.tokens) && real.tokens > 0) { tokens = real.tokens; measured = true }
        } catch (error) {}
        if (tokens < Number(cfg.threshold)) continue
        if (now < Number(st.nextAttemptAt || 0)) continue
        if (now - Number(st.lastCompactAt || 0) < Number(cfg.cooldownMinutes) * 60_000) continue
        // 空闲判定要感知她是不是正忙着：QQ 层没新消息 ≠ 会话闲着 —— 她可能在生图/翻唱/跑工具
        //（一跑就是几十秒到几分钟），这时候压缩会把正在工作的会话拦腰 reset 掉。
        try { if (hub.isBusy?.(chatId)) continue } catch (error) {}
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
        const r = await compact(key, { chatId }, { tokens, measured })
        // 自动压缩失败（常见：模型被限流）不要每 30 秒刷一遍 warn，交给面板/手动重试
        if (!r.ok && r.reason !== 'no-transcript') api.log.debug(`${ID}：自动压缩没成，下次再试`);
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
    // state 每 5 条消息才落盘（activity 高频），崩溃最多丢 4 条计数 —— 30 秒兜底刷一次（P1-6）
    flushTimer = setInterval(() => { try { persist() } catch (error) {} }, 30_000)
    flushTimer.unref?.()

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
        tokens: (() => {
          try {
            const real = latestByChat.get(chatId)
            if (real && Number.isFinite(real.tokens) && real.tokens > 0) return real.tokens
          } catch (error) {}
          return estimate(st.chars)
        })(),
        estimated: !(() => { try { const r = latestByChat.get(chatId); return Boolean(r && r.tokens > 0) } catch (error) { return false } })(),
        compacts: Number(st.compacts || 0),
        lastAt: Number(st.lastAt || 0),
        lastCompactAt: Number(st.lastCompactAt || 0),
        lastAttemptAt: Number(st.lastAttemptAt || 0),
        nextAttemptAt: Number(st.nextAttemptAt || 0),
        failures: Number(st.failures || 0),
        lastError: String(st.lastError || ''),
        busy: compactBusy.has(chatId),
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
      const r = await compact(chatId, { chatId })
      return r.ok
        ? { ok: true, message: `压缩好了（第 ${r.compacts} 次，摘要 ${r.chars} 字）` }
        : { ok: false, reason: r.reason, message: r.message || '这次没压成' }
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

    api.onDispose(() => { if (timer) clearInterval(timer); if (flushTimer) clearInterval(flushTimer); persist() })

    return {
      compact,
      state: () => ({ ...state }),
      summaries: () => ({ ...summaries }),
      estimate,
    }
  },
}
