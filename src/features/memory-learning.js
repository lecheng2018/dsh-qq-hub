import { askModel } from '../core/llm.js'
import { collectMemberLines, enoughEvidence, evidenceFunnel, describeFunnel, buildDistillPrompt, parseDistillProfile, dedupConvo, safeParseJson, recognizedFields } from './distill.js'
import { sessionsDirFor, scanTranscripts, speakerCounts } from './session-history.js'
import { workspaceDirOf } from '../chat/workspace.js'
import { readChatLogSource } from '../chat/chat-log.js'
import { createMemoryExtractor } from './memory-extractor.js'
import { similarity, whenText } from './memory-core.js'
import { createMemoryReflection } from './memory-reflection.js'

export function createMemoryLearning({
  dsh, getConfig, hub, chatLog = hub, log, personaText, onDistillLearned,
  isActive, createGenerationSignal, generationOf,
  load, save, health, relatedTo,
  add, revise, supersede, scopeFromChatId,
  profileOf, setDerivedProfile, profileKeyOf,
  insightsOf, setDerivedInsights, styleOf, setStyle, personKey,
  distillOf, putDistill, reflectImpl,
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
      // 12000：五段 JSON 本身就长，思考型模型还要先花掉一大截在思考段上。
      // 实测 8000 时回包被截断（数组写到一半就断），JSON 解析直接失败 —— 这是
      // 「模型判空」的另一条暗线，和键名漂移叠加在一起。
      // reasoningEffort 不钉死 'none'：自适应思考类模型 disabled 会 400，
      // 交给 askModel 的 pickReasoningEffort 按模型能力挑。
      out = await askModel(dsh, { cfg, system, text, maxTokens: 12000, temperature: 0.3, signal: genSignal.signal })
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
      // 判空有三种完全不同的原因，别一律说「证据不足」糊弄用户：
      //   a) 模型没按约定键名回包（实测会写「句子架构」「口头禅」甚至自创 learned_style）
      //   b) 回包被截断（maxTokens 不够，JSON 只写了一半）
      //   c) 模型认真看完后认为没有可提炼的稳定特征
      const fields = recognizedFields(safeParseJson(out))
      const fieldText = Object.keys(fields).length ? Object.entries(fields).map(([k, n]) => `${k}×${n}`).join('、') : '无'
      const rawLen = String(out || '').length
      const looksTruncated = !/}\s*$/.test(String(out || '').trim())
      log.info(`蒸馏群友（历史）：${t0name} 画像判空（识别到字段：${fieldText}；回包 ${rawLen} 字${looksTruncated ? '，结尾不完整疑似截断' : ''}），原始前 400 字：`, String(out).slice(0, 400))
      if (!Object.keys(fields).length && looksTruncated) {
        return { ok: false, message: `模型回包被截断了（写了 ${rawLen} 字还没收尾），没法学。可以再点一次重试，或把蒸馏用模型换成上下文更大的模型` }
      }
      if (!Object.keys(fields).length) {
        return { ok: false, message: '模型没按约定的字段名回包（认不出 exchanges/syntax 等任何一个），所以没法入库。原文已记日志，可再点一次重试' }
      }
      return { ok: false, message: '模型看完认为他的原话里没有稳定可学的说话特征，暂时不学（不是句数不够，句数已经够了）' }
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
    const sourceState = load()
    const sourceRev = sourceState.rev || 0
    const mine = sourceState.items
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
      return setDerivedProfile(qq, text, name, scope, mine, sourceRev)
    } finally {
      task.cleanup()
    }
  }


  const defaultReflection = createMemoryReflection({
    dsh, getConfig, personaText, log,
    insightsOf, setDerivedInsights, styleOf, setStyle,
    createGenerationSignal, generationOf, isActive,
  })
  function reflect(chat, transcript, genSignal = null) {
    return reflectImpl ? reflectImpl(chat, transcript, genSignal) : defaultReflection.reflect(chat, transcript, genSignal)
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
