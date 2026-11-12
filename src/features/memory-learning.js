import { randomUUID } from 'node:crypto'
import { askModel } from '../core/llm.js'
import { collectMemberLines, enoughEvidence, evidenceFunnel, describeFunnel, buildDistillPrompt, parseDistillProfile, dedupConvo } from './distill.js'
import { sessionsDirFor, scanTranscripts, speakerCounts } from './session-history.js'
import { workspaceDirOf } from '../chat/workspace.js'
import { readChatLogSource } from '../chat/chat-log.js'
import { createMemoryExtractor } from './memory-extractor.js'
import { parseReflection, similarity, whenText } from './memory-core.js'

export function createMemoryLearning({
  dsh, getConfig, hub, chatLog = hub, log, personaText, onDistillLearned,
  isActive, createGenerationSignal, generationOf,
  load, save, health, relatedTo,
  add, revise, supersede, scopeFromChatId,
  profileOf, setProfile, profileKeyOf,
  insightsOf, setInsights, styleOf, setStyle, personKey,
  distillOf, putDistill,
}) {
  const sourceLog = chatLog?.listDays ? chatLog : { listDays: () => hub?.chatLogDays?.() || [], readDay: (day) => hub?.chatLogOf?.(day) || [] }
  const chatLogDays = () => sourceLog.listDays()
  const chatLogSnapshot = (day) => readChatLogSource(sourceLog, day)
  let batchRecoveryError = ''

  /** 从人设文本里抽「禁止」类硬规则行，给 style 学习当护栏（人设没写或没传 personaText 就返回空）。 */
  const personaGuard = () => {
    try {
      const t = String(personaText?.() || '')
      if (!t) return ''
      const lines = t.split('\n').map((l) => l.trim()).filter((l) => l && l.length <= 80 && /禁止|不要|不许|不得|别成|别用|别刻意/.test(l))
      if (!lines.length) return ''
      return lines.slice(0, 12).join('\n')
    } catch { return '' }
  }

  /** 导入旧档案第一步：让模型从一大段文字里挑出值得记的，返回候选（不直接存）。 */
  async function importCandidates(text) {
    const task = generationOf(null)
    const genSignal = task.signal
    try {
      const src = String(text || '').trim()
      if (!src) return []
      const chunks = []
      for (let i = 0; i < src.length && chunks.length < 6; i += 5000) chunks.push(src.slice(i, i + 5000))
      const out = []
      for (const part of chunks) {
        const r = await askModel(dsh, {
          cfg: getConfig(),
          system: '你帮一个叫「大肥鱼」的聊天角色从旧档案（设定、聊天笔记、以前的记忆文件）里挑出值得长期记住的事：别人的名字/称呼、喜好、身份、约定、重要经历、和她的关系。不要记她自己的人设和外貌（那些在人格里），不要记无关的说明文字。每条一句话、主语写清楚。只输出 JSON 数组，例如 [{"text":"小明喜欢吃辣","about":"小明","importance":0.6}]。',
          text: part,
          maxTokens: 2500,
          temperature: 0.2,
          signal: genSignal.signal,
        })
        const m = String(r).match(/\[[\s\S]*\]/)
        try { for (const x of m ? JSON.parse(m[0]) : []) if (x && x.text) out.push({ text: String(x.text).slice(0, 200), aboutName: String(x.about || ''), importance: Math.max(0, Math.min(1, Number(x.importance) || 0.5)) }) } catch (error) {}
      }
      const have = load().items
      const uniq = []
      for (const c of out) if (!have.some((m) => similarity(m.text, c.text) >= 0.6) && !uniq.some((u) => similarity(u.text, c.text) >= 0.6)) uniq.push(c)
      return uniq.slice(0, 80)
    } catch (error) {
      if (!genSignal.isValid()) return []
      throw error
    } finally {
      task.cleanup()
    }
  }


  // ---------------- 从会话历史蒸馏（1.3.63）----------------
  // chatlog 按保留天数滚动清理；会话记录留得更久。但**会话记录会脱敏主人**：
  // 群聊上下文里主人发言被渲染成「主人：…」（不带 QQ 号，见 chat/hub.js 的 whoOf），
  // 而解析正则要求「名字(数字)：」——所以主人自己的发言永远捞不到，句数卡死不变。
  // chatlog 存的是真实 uid，不受这层脱敏影响，且能精确按群 id 过滤。

  /**
   * 扫一遍历史，给出「谁说了多少句」和覆盖的时间范围（面板用）。
   * 证据源优先 chatlog（真实 uid + 可精确按群 id 过滤），会话记录只作补充。
   */
  function distillHistory ({ gid = '' } = {}) {
    const cfg = getConfig()
    const dir = sessionsDirFor(workspaceDirOf(cfg), { dshHome: process.env.DSH_HOME || '' })
    const group = String(gid || '').replace(/\D/g, '')
    // 群名只用于会话记录那边的粗过滤（它按【群聊 xxx】头匹配）
    let groupName = ''
    if (group && hub?.groupNames?.get) { try { groupName = hub.groupNames.get(group) || '' } catch {} }
    const scan = scanTranscripts(dir, { group: groupName })

    // chatlog：真实 uid，能按 chatId 精确过滤
    const logLines = []
    let logDays = []
    try {
      logDays = chatLogDays().slice().sort()
      for (const day of logDays) {
        // chatLogSnapshot 给的是 { day, records, ... } 快照对象，不是数组
        for (const r of (chatLogSnapshot(day)?.records || [])) {
          if (!r || !r.text) continue
          if (group && String(r.chatId) !== `group:${group}`) continue
          logLines.push({
            name: String(r.who || r.uid || ''),
            uid: String(r.uid || ''),
            text: String(r.text || ''),
            at: Number(r.t) || 0,
          })
        }
      }
    } catch (error) {
      log?.warn?.('蒸馏：读 chatlog 失败，退回会话记录：', error.message)
    }

    // 合并：chatlog 优先（有真实 uid），会话记录补更早的历史
    const merged = [...logLines]
    const seenKey = new Set(logLines.map((l) => `${l.uid}|${String(l.text).trim().slice(0, 80)}`))
    for (const l of scan.lines) {
      const k = `${l.uid}|${String(l.text).trim().slice(0, 80)}`
      if (seenKey.has(k)) continue
      seenKey.add(k)
      merged.push({ name: l.name, uid: l.uid, text: l.text, at: Number(l.at) || 0 })
    }

    let from = 0
    let to = 0
    for (const l of merged) {
      if (!l.at) continue
      if (!from || l.at < from) from = l.at
      if (l.at > to) to = l.at
    }
    return {
      dir,
      sessions: scan.sessions,
      chatlogDays: logDays.length,
      chatlogLines: logLines.length,
      total: merged.length,
      from,
      to,
      speakers: speakerCounts(merged, 20),
      lines: merged,
    }
  }

  /**
   * 从历史里给某个目标学一次（立即出画像，不用等）。
   * @returns {{ok:boolean, message:string, learned?:object}}
   */
  async function learnDistillFromHistory ({ gid, uid, name = '', minMessages } = {}) {
    const task = generationOf(null)
    const genSignal = task.signal
    try {
      const cfg = getConfig()
    if (cfg.memory?.distill === false) return { ok: false, message: '蒸馏群友开关关着' }
    const g = String(gid || '').replace(/\D/g, '')
    const u = String(uid || '').replace(/\D/g, '')
    if (!g || !u) return { ok: false, message: '群号和 QQ 号都要填' }
    // 按群 id 精确过滤（chatlog 有 chatId；会话记录那边靠群名粗过滤兜底）
    const hist = distillHistory({ gid: g })
    if (!hist.total) {
      const where = hist.chatlogDays ? `${hist.chatlogDays} 天聊天流水 + ` : ''
      return { ok: false, message: `没找到历史记录（翻了 ${where}${hist.sessions} 个会话）` }
    }
    // 历史学习先清洗（去重 + 滤纯转发），清洗后质量高，门槛相应降到 15 句
    const mine = collectMemberLines(hist.lines.map((l) => ({ ...l, t: l.at })), u)
    const t0name = name || (hist.lines.find((l) => String(l.uid) === u) || {}).name || u
    const minMsg = Number(minMessages) || 15
    if (!enoughEvidence(mine, { minMessages: minMsg })) {
      const funnel = evidenceFunnel(hist.lines, u)
      return {
        ok: false,
        message: `历史里他的原话只有 ${mine.length} 句（去重滤转发后），不够 ${minMsg} 句，学出来也是瞎猜——等多聊几天再来${describeFunnel(funnel)}`,
        funnel,
      }
    }
    const others = hist.lines.filter((l) => String(l.uid) !== u && !/^\[分享卡片|^https?:/.test(String(l.text))).slice(-60).map((l) => `${l.name}：${String(l.text).slice(0, 100)}`)
    const old = distillOf(g, u)
    const { system, text } = buildDistillPrompt({
      name: name || (hist.lines.find((l) => String(l.uid) === u) || {}).name || u,
      uid: u,
      memberLines: mine,
      context: dedupConvo(hist.lines).slice(-80),
      others,
      old,
    })
    let out = ''
    try {
      // 8000：五段 JSON 会被截断（parse 就失败）；「自适应思考」模型的思考段也吃额度。
      // reasoningEffort 不钉死 'none'：MiniMax-M3.1-Flash 之类必须自适应思考，disabled 直接 400
      // → 蒸馏永远失败；交给 askModel 的 pickReasoningEffort 按模型能力挑。
      out = await askModel(dsh, { cfg, system, text, maxTokens: 8000, temperature: 0.3, signal: genSignal.signal })
    } catch (error) {
      return { ok: false, message: '提炼失败：' + error.message }
    }
    const profile = parseDistillProfile(out)
    if (!profile) {
      log.warn(`蒸馏群友（历史）：${t0name} 回包解析失败，原始前 200 字：`, String(out).slice(0, 200))
      return { ok: false, message: '模型回包没解析成 JSON（原因已记日志，可再点一次重试）' }
    }
    const hasProfile = Boolean(profile.exchanges?.length || profile.syntax?.length || profile.catchphrases?.length || profile.rhetoric?.length || profile.persona?.length || profile.samples?.length || profile.style?.length)
    if (!hasProfile) {
      log.info(`蒸馏群友（历史）：${t0name} 模型判空画像（可能重复转发太多），原始前 120 字：`, String(out).slice(0, 120))
      return { ok: false, message: '模型认为他的原话不够代表说话风格，暂时不学' }
    }
      if (!isActive() || !genSignal.isValid()) return { ok: false, message: '历史学习任务已取消' }
      const saved = putDistill(g, u, profile, mine.length)
      log.info(`蒸馏群友（历史）：学到 ${name || u} 的说话样子（${mine.length} 句原话）`)
      try { onDistillLearned && await onDistillLearned(g) } catch (error) { log.warn('刷新语感人设卡出错：', error.message) }
      return { ok: true, message: `从历史里学到了（${mine.length} 句）`, learned: saved }
    } finally {
      task.cleanup()
    }
  }

  /** 按这个人的记忆重写小档案（记忆少于 3 条的不写）。scope 限定只用哪个作用域的记忆来写。 */
  async function buildProfile(qq, scope = '', genSignal = null) {
    const task = generationOf(genSignal)
    genSignal = task.signal
    try {
      if (!isActive()) return false
      if (genSignal && !genSignal.isValid()) return false
    const cfg = getConfig()
    // 只用「这个作用域自己的」记忆写档案。
    // 以前还会把 global 记忆也喂进来（`|| scope === 'global'`），后果是：
    // 在陌生群里给主人写档案时，会把主人私聊里的私事混进去，提炼成一条 global 档案，
    // 于是「私事 → global → 哪里都能读」—— 等于绕过了所有隔离。
    // global 档案该由 global 自己那条线维护，不该由别的聊天代写。
    // scope 为空必须拒绝（fail-closed）：兜不住空 scope 就退化成全库，跨域污染重演。
    if (!String(scope || '').trim()) throw new Error('没说清用哪个作用域的记忆（private:/group:/global），拒绝重写')
    const mine = load().items
      .filter((m) => !m.invalidAt && String(m.about) === String(qq))
      .filter((m) => String(m.scope || '') === String(scope))
      .sort((a, b) => a.at - b.at)
    if (mine.length < 3) return false
    const name = mine.filter((m) => m.aboutName).at(-1)?.aboutName || ''
    const old = profileOf(qq, scope)?.text || ''
    let out = ''
    try {
      out = await askModel(dsh, {
        cfg,
        system: '你是「大肥鱼」。根据你记得的关于一个人的事，写一张给自己看的人物小档案：TA 是谁、怎么称呼、和你什么关系、性格和喜好、最近在忙什么。只写记忆里明确有的，不要推测性格、不要编，也不要写「应该」「可能」这种猜的话；旧档案和新记忆矛盾时以新记忆为准。用第三人称，一段话，100 字以内，不要标题和列表。',
        text: `${String(qq) === String(cfg.ownerQQ) ? `这是你的${cfg.ownerName || '主人'}。\n` : ''}旧档案：${old || '（还没有）'}\n\n记得的事（越往下越新）：\n${mine.slice(-40).map((m) => `- [${whenText(m.at)}] ${m.text}`).join('\n')}`,
        maxTokens: 1500,
        temperature: 0.3,
        signal: genSignal?.signal,
      })
    } catch (err) {
      if (genSignal && !genSignal.isValid()) return false
      throw err
    }
    if (!isActive() || (genSignal && !genSignal.isValid())) return false
    const text = String(out || '').trim().replace(/^[「"]|[」"]$/g, '')
    if (!text) throw new Error('模型没写出东西，等会儿再试')
      setProfile(qq, text, name, scope)
      return true
    } finally {
      task.cleanup()
    }
  }


  /** 回顾：结合最近聊天和已有经验，更新这个人的相处经验（合并、提炼、最多 8 条，概括不琐碎）。 */
  async function reflect(chat, transcript, genSignal = null) {
    const task = generationOf(genSignal)
    genSignal = task.signal
    try {
      const key = personKey(chat)
    if (!key) return 0
    const old = insightsOf(key)
    const oldStyle = styleOf(key)
    const who = chat.kind === 'group' ? '这个群' : '对方'
    const out = await askModel(dsh, {
      cfg: getConfig(),
      system: '你是「大肥鱼」，在回顾自己和' + who + '的相处。输出一个 JSON 对象 {"insights":[...],"style":[...]}。\n'
        + 'insights：「怎么相处更好」的经验。概括性的、可复用的相处之道（比如「他累的时候不想多聊，简单安慰就好」「喜欢被吐槽，不喜欢太正经」），不要记具体事件和事实细节；和已有经验重复的合并，过时或被证伪的删掉，不超过 8 条，每条不超过 30 字。\n'
        + 'style：' + who + '的说话方式，以及你和' + who + '聊天时可以自然贴近的地方（比如「消息很短，常一句话分几条发」「爱用“hhh”和“草”」「不爱用标点」「喜欢叠字」），只写说话的形式和习惯，不写内容；不超过 5 条，每条不超过 30 字。\n'
        + (personaGuard() ? '人设硬性规则（style 不得与它冲突；被禁止的标点、格式、长度，对方用得再多也不许学）：\n' + personaGuard() + '\n' : '')
        + '只输出这个 JSON 对象。',
      text: `已有经验：\n${old.map((x) => '- ' + x.text).join('\n') || '（还没有）'}\n\n已记下的说话方式：\n${oldStyle.map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n最近的聊天：\n${transcript}`,
      maxTokens: 1500,
      temperature: 0.3,
      signal: genSignal?.signal,
    })
    if (!isActive() || (genSignal && !genSignal.isValid())) throw new Error('回顾任务已取消')
    const { insights: rawIns, style: rawStyle } = parseReflection(out)
    if (rawStyle.length) setStyle(key, rawStyle)
    const arr = rawIns.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 8)
    if (!arr.length) return 0
    const now = Date.now()
    setInsights(key, arr.map((text) => old.find((x) => x.text === text) || { id: randomUUID().slice(0, 8), text, at: now }), chat.nickname || chat.groupId || '')
    log.info(`更新了和 ${key} 相处的经验（${arr.length} 条）`)
      return arr.length
    } finally {
      task.cleanup()
    }
  }


  function commitExtracted(x, { chatId, cfg, known, about }) {
    const op = String(x.op || 'add')
    const target = known.get(String(x.id || '').replace(/^#/, ''))
    if (op === 'update' && target && target.source !== 'panel') return revise(target.id, x.text, x.importance)
    if (op === 'outdated' && target) {
      return supersede({
        oldId: target.id,
        text: x.text,
        aboutName: x.about || target.aboutName || '',
        about: about || target.about || '',
        importance: x.importance ?? target.importance ?? 0.5,
        source: 'auto',
        chatId,
        scope: scopeFromChatId(chatId),
        evidence: x.evidence,
        entity: x.entity,
        topic: x.topic,
      }).ok
    }
    const tags = Array.isArray(x.tags) ? x.tags.map((tag) => String(tag).slice(0, 8)).slice(0, 2) : []
    const result = add({
      text: x.text,
      aboutName: x.about || '',
      about,
      tags,
      importance: x.importance ?? 0.5,
      source: 'auto',
      chatId,
      scope: scopeFromChatId(chatId),
      evidence: x.evidence,
      entity: x.entity,
      topic: x.topic,
    })
    return result.ok && (result.id || result.updated)
  }

  const batchState = {
    get: (id) => load().extractionBatches?.[id],
    start: (batch, scope) => {
      const state = load()
      state.extractionBatches = { ...(state.extractionBatches || {}) }
      state.extractionBatches[batch.id] = { fingerprint: batch.fingerprint, scope, status: 'running', added: 0, at: Date.now() }
      try { save(state) } catch (error) {
        batchRecoveryError = `提炼批次 ${batch.id} 无法记录运行状态，自动整理已暂停：${error.message}`
        throw error
      }
    },
    fail: (batch, scope, error) => {
      const state = load()
      state.extractionBatches = { ...(state.extractionBatches || {}) }
      state.extractionBatches[batch.id] = {
        fingerprint: batch.fingerprint,
        scope,
        status: error.factsCommitted ? 'pending' : 'failed',
        added: Number(error.factsCommitted) || 0,
        error: error.message,
        at: Date.now(),
      }
      try { save(state) } catch (saveError) {
        batchRecoveryError = `提炼批次 ${batch.id} 无法记录失败状态，自动整理已暂停：${saveError.message}`
        throw saveError
      }
    },
    done: (batch, scope, added) => {
      const state = load()
      state.extractionBatches = { ...(state.extractionBatches || {}) }
      state.extractionBatches[batch.id] = { fingerprint: batch.fingerprint, scope, status: 'done', added, at: Date.now() }
      try { save(state) } catch (error) {
        batchRecoveryError = `提炼批次 ${batch.id} 已提交事实但进度未确认，自动整理已暂停：${error.message}`
        throw error
      }
    },
  }
  const extractor = createMemoryExtractor({
    dsh, getConfig, relatedTo, commit: commitExtracted, isActive,
    reflect, batchState, scopeOf: scopeFromChatId, recoveryError: () => batchRecoveryError, log,
    consolidation: {
      health, load, save, chatLogDays, chatLogSnapshot,
      learnSelfStyle, buildProfile, profileKeyOf, createGenerationSignal,
    },
  })
  function extractFacts(chatId, transcript, genSignal = null) {
    return extractor.extractFacts(chatId, transcript, genSignal)
  }
  function extractLines(chatId, lines, genSignal = null) {
    return extractor.extractLines(chatId, lines, genSignal)
  }

  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  function consolidate(o = {}) {
    return extractor.consolidate(o)
  }

  /** 从各人的说话方式里，沉淀出几条她自己不知不觉学会的说法（很少、很淡）。 */
  async function learnSelfStyle(genSignal = null) {
    const task = generationOf(genSignal)
    genSignal = task.signal
    try {
      if (!isActive()) return
      if (genSignal && !genSignal.isValid()) return
    const s = load()
    const pool = Object.entries(s.styles || {}).filter(([k]) => k !== 'self').flatMap(([, v]) => v)
    if (pool.length < 3) return
    try {
      const out = await askModel(dsh, {
        cfg: getConfig(),
        system: '你是「大肥鱼」。下面是你和不同的人聊天时注意到的说话习惯，以及你自己已经养成的说法。挑出你和大家聊久了、自然会被带上的说话方式（口头禅、语气词、发消息的节奏），保持你原本的性格，不超过 6 条，每条不超过 20 字。只输出 JSON 数组。' + (personaGuard() ? ' 注意：下面这些人设硬性规则优先级最高，学到的说法不得与它冲突：' + personaGuard() : ''),
        text: `已经养成的：\n${styleOf('self').map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n大家的说话习惯：\n${pool.map((x) => '- ' + x).join('\n')}`,
        maxTokens: 800,
        temperature: 0.3,
        signal: genSignal?.signal,
      })
      if (!isActive() || (genSignal && !genSignal.isValid())) return
      const m = out.match(/\[[\s\S]*\]/)
      const arr = m ? JSON.parse(m[0]).map((t) => String(typeof t === 'string' ? t : t?.text || '')) : []
      if (arr.length) setStyle('self', arr)
    } catch (error) {
      if (genSignal && !genSignal.isValid()) return
      log.warn('沉淀说话方式失败：', error.message)
    }
    } finally {
      task.cleanup()
    }
  }

  /** 每分钟调一次：一天几个整理时间点（默认 04:00 / 16:00），到点且这个点今天还没跑过就整理。 */
  async function tick() {
    if (!isActive() || !health().ok) return
    const cfg = getConfig().memory
    if (!cfg.enabled || !cfg.dailyConsolidate) return
    const s = load()
    const today = dayKey()
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const runs = s.runs || {}
    const due = (cfg.consolidateTimes || []).filter((t) => {
      const [hh, mm] = String(t).split(':').map(Number)
      return mins >= hh * 60 + mm && runs[t] !== today
    })
    if (!due.length) return
    // 连今天到目前为止的聊天一起提炼；记着整理到第几行，下一次只处理新的
    const r = await consolidate({ includeToday: true })
    if (r.ok) {
      const s2 = load()
      s2.runs = { ...(s2.runs || {}) }
      for (const t of due) s2.runs[t] = today
      save(s2)
    }
  }


  return {
    api: {
      importCandidates, distillHistory, learnDistillFromHistory,
      buildProfile, reflect, learnSelfStyle, consolidate, tick,
    },
    reload: () => { batchRecoveryError = '' },
  }
}
