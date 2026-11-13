// 目的机制（主动搭话引擎）的 QQ Hub 接线层。
//
// 引擎本体在 ./engine.js（逻辑移植自 Mieksido/surfcore 的 purpose-engine，MIT，
// 署名见 THIRD-PARTY-NOTICES.md；零 import 零 I/O 的纯函数）。
// 本文件负责副作用：状态文件、素材采集（记忆 + 聊天流水适配）、生成（hub.runSystemTurn）、
// 投递（hub.deliver）、追问、路由。
//
// 使用方式：独立的 purpose 内置模块（src/modules/purpose/index.js），默认关闭；
// 现有的「主动搭话」模块（speakup，src/features/companion.js）保持默认实现不变，
// 想换引擎的主人自己开关，迁移说明见 docs/PURPOSE_MODULE_API.md。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { stripInternalMemo } from '../chat/reply.js'
import { characterName, escapeRegExp } from '../persona/identity-context.js'
import {
  DEFAULT_PURPOSE_CONFIG, PURPOSE_NEEDS, NEED_LABELS,
  normalizePurposeConfig, createPurposeState, normalizePurposeState,
  ensurePurposeDay, ensurePurposeSchedule, planNextFire, evaluatePurposeTick,
  markPurposeDelivered, markPurposeSkip, applyPurposeOutcome,
  collectMaterials, analyzePersona, deriveDrives, formGoalHypotheses,
  minePurposeSeeds, selectPurpose, buildPurposePrompt, parsePurposeMemo,
  summarizePurposeState,
} from './engine.js'

const MINUTE = 60_000
const SILENCE = '[沉默]'

const pad2 = (n) => String(n).padStart(2, '0')
const clampInt = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d
}

/**
 * 把 QQ Hub 配置映射成引擎配置。
 * 醒着窗口（speakUp.awakeFrom/awakeTo）是唯一真相，引擎的安静时段由它派生；
 * 调参走本模块自己的设置面 cfg.ext.purpose.*（模块默认关：ext.purpose.enabled）。
 */
export function purposeConfig(cfg = {}) {
  const su = cfg.speakUp || {}
  const ext = (cfg.ext && cfg.ext.purpose) || {}
  const awakeFrom = clampInt(ext.awakeFrom ?? su.awakeFrom, 8, 0, 24)
  const awakeTo = clampInt(ext.awakeTo ?? su.awakeTo, 23, 0, 24)
  // awake 窗口为全天（awakeTo>=24 或区间非法）时，安静时段关闭（start===end 视为不启用）
  const quiet = awakeTo >= 24 || awakeFrom >= awakeTo
    ? { quietStart: '00:00', quietEnd: '00:00' }
    : { quietStart: `${pad2(awakeTo % 24)}:00`, quietEnd: `${pad2(awakeFrom)}:00` }
  return normalizePurposeConfig({
    // 总开关只看本模块自己的设置（ext.purpose.enabled，默认 false）；
    // 与旧的「主动搭话」互不影响——两套同时开会重复打扰，迁移说明里提醒主人别同时开。
    enabled: cfg.enabled !== false && ext.enabled === true,
    ownerUin: cfg.ownerQQ,
    gapMinMs: clampInt(ext.minIntervalMinutes ?? su.minIntervalMinutes, 90, 5, 2880) * MINUTE,
    gapMaxMs: clampInt(ext.maxIntervalMinutes ?? su.maxIntervalMinutes, 240, 5, 2880) * MINUTE,
    initialDelayMinMs: clampInt(ext.initialDelayMinutes, 15, 1, 720) * MINUTE,
    // 每日上限：只在填了大于 0 的数时才用本模块自己的值；
    // 0、空、没设都沿用「主动搭话」的 maxPerDay（engine 里 dailyMax>0 才拦截，所以沿用的值照常生效）。
    // 注意 ?? 只认 null/undefined，面板存下来的空字符串会绕过它——所以这里要显式判空。
    dailyMax: (Number(ext.maxPerDay) > 0 ? clampInt(ext.maxPerDay, 3, 0, 20) : clampInt(su.maxPerDay, 3, 0, 20)),
    idleThresholdMs: clampInt(ext.idleMinutes ?? su.idleMinutes, 40, 0, 1440) * MINUTE,
    minMaterials: clampInt(ext.minMaterials, DEFAULT_PURPOSE_CONFIG.minMaterials, 0, 20),
    maxMaterials: clampInt(ext.maxMaterials, DEFAULT_PURPOSE_CONFIG.maxMaterials, 6, 80),
    maxCandidates: clampInt(ext.maxCandidates, DEFAULT_PURPOSE_CONFIG.maxCandidates, 3, 10),
    promptMaxChars: clampInt(ext.promptMaxChars, DEFAULT_PURPOSE_CONFIG.promptMaxChars, 4000, 30000),
    ...quiet,
  })
}

/**
 * 模型回包清洗：去掉备忘段、引号、「角色名：」前缀；空/沉默返回 ''。
 *
 * 名字必须由调用方给（身份中枢解析出来的那份），这里不再写死某张卡：
 * 换卡后模型会以新名字开头，「名字：」前缀仍要洗掉。
 * @param {string} raw 模型原始回包
 * @param {string|string[]} [role] 当前角色名 / 她自己会用的称呼
 */
export function cleanReply(raw, role = '') {
  let s = stripInternalMemo(raw)
  s = s.replace(/^[「“"'']+/, '').replace(/[」”"'']+$/, '')
  const names = (Array.isArray(role) ? role : [role]).map((n) => String(n ?? '').trim()).filter(Boolean)
  if (names.length) {
    const alts = names.map((n) => escapeRegExp(n)).join('|')
    s = s.replace(new RegExp(`^(?:${alts})\\s*[:：]\\s*`), '')
  }
  s = s.trim()
  if (!s || s.replace(/\s/g, '').startsWith(SILENCE)) return ''
  return s
}

export function createPurpose({ getConfig, hub, chatLog, log, isMuted, memory, personaText }) {
  // 她的自称统一问身份中枢（换卡即生效），本文件不再持有角色名常量。
  const roleOf = (cfg = getConfig()) => characterName('', cfg)
  const memoryOf = () => { try { return memory?.() || null } catch { return null } }
  const chatIdOf = (cfg) => `private:${cfg.ownerQQ}`
  const lastPrivateAt = (cfg) => Math.max(hub?.lastOwnerChatAt || 0, hub?.lastBotToOwner?.at || 0)
  const stateFile = () => dataDir('purpose', 'purpose-state.json')
  const nudgeFile = () => dataDir('purpose', 'nudge.json')

  // ---------- 状态 ----------
  function loadState(config, now = Date.now()) {
    const raw = readJson(stateFile(), null)
    const state = normalizePurposeState(raw, now)
    if (!raw) {
      // 旧 speakup.json 只读迁移当日次数，之后弃用
      const legacy = readJson(dataDir('speakup.json'), null)
      const legacyCount = Number(legacy?.count) || 0
      if (legacy?.day === new Date(now).toDateString() && legacyCount > 0) state.countToday = legacyCount
    }
    if (state.lastOutcome === 'pending') { // 重启不补发：上次在途改判 interrupted，归零重排
      state.lastOutcome = 'interrupted'
      state.nextFireAt = 0
    }
    ensurePurposeDay(state, now)
    ensurePurposeSchedule(state, { now, config })
    return state
  }
  const saveState = (state) => writeJson(stateFile(), state)

  // ---------- 素材（记忆 importance 0~1 → 引擎 0~100） ----------
  function memoryRecords() {
    try {
      const mem = memoryOf()
      if (!mem) return []
      // 后台素材采集没有 chat：只允许 global + 主人私聊域（fail-closed，不拿全库）
      const cfg = getConfig()
      const scopes = cfg.ownerQQ ? ['global', `private:${cfg.ownerQQ}`] : ['global']
      const items = (mem.recall?.('最近 在做 想起 关心 日常', { limit: 200, scopes }) || [])
        .map((h) => ({ ...h, ...(h.it || {}), text: h.text || h.it?.text }))
      return items
        .filter((m) => m && !m.invalidAt && m.text)
        .map((m) => ({
          id: m.id,
          title: '',
          text: String(m.text),
          importance: Math.round((Number(m.importance) || 0) * 100),
          emotional: 0, // qq-hub 记忆没有情绪分字段，留 0
          lastSeenAt: m.lastHit || m.at,
          createdAt: m.at,
          pinned: false, anchor: false, isInitial: false,
        }))
    } catch {
      return []
    }
  }

  // 共享聊天流水 → 引擎的 conversations 结构：只看主人私聊 + 最近群
  function conversations(cfg, now = Date.now()) {
    const ownerKey = chatIdOf(cfg)
    const per = new Map()
    const pick = (chatId) => {
      let c = per.get(chatId)
      if (!c) { c = { key: chatId, recentMessages: [], activeTopics: [], pendingThoughts: [] }; per.set(chatId, c) }
      return c
    }
    try {
      const days = chatLog?.listDays?.() || hub.chatLogDays?.() || []
      for (const day of days.slice(-2)) {
        for (const e of chatLog?.readDay?.(day) || hub.chatLogOf?.(day) || []) {
          if (!e?.chatId) continue
          if (e.chatId !== ownerKey && !String(e.chatId).startsWith('group:')) continue
          pick(e.chatId).recentMessages.push({
            text: String(e.text || ''),
            time: Number(e.t) || 0,
            isSelf: e.who === 'bot',
            isOwner: e.chatId === ownerKey && e.who !== 'bot',
            sender: e.who === 'bot' ? roleOf(cfg) : String(e.uid || '群友'),
          })
        }
      }
    } catch {}
    // 只保留窗口内有内容的会话
    const windowStart = now - 72 * 60 * MINUTE
    return [...per.values()].filter((c) => c.recentMessages.some((m) => m.time >= windowStart))
  }

  const personaOf = (cfg) => {
    try { return analyzePersona(personaText?.() || '') } catch { return analyzePersona('') }
  }

  // ①~④ 收素材 → 驱动 → 目标假设 → 候选（只读，不落盘）
  function prepare(cfg, config, state, now = Date.now()) {
    const role = roleOf(cfg)
    const materials = collectMaterials({
      now, config,
      ownerUin: cfg.ownerQQ,
      roleName: role,
      conversations: conversations(cfg, now),
      biliEntries: [], // 首期不接 B站/Qzone 素材，字段留扩展
      memoryRecords: memoryRecords(),
    })
    const persona = personaOf(cfg)
    const lastMasterAt = lastPrivateAt(cfg)
    const { drives } = deriveDrives({
      drives: state.drives, drivesAt: state.drivesAt,
      materials: materials.items, now, lastMasterAt, personaBias: persona.bias,
    })
    const { goals, observations } = formGoalHypotheses({
      materials: materials.items, goals: state.goals, observations: state.observations,
      drives, now, lastMasterAt, config, roleName: role, persona,
    })
    const seeds = minePurposeSeeds({
      materials: materials.items, now, roleName: role, config,
      drives, history: state.history, lastMasterAt,
    })
    return { materials, persona, lastMasterAt, drives, goals, observations, seeds }
  }

  function promptFor(cfg, config, selected, ctx, state, now = Date.now()) {
    return buildPurposePrompt({
      now, config, mode: 'auto', // 模型直接输出那句话（QQ Hub 没有 QQ 发送工具）
      ownerUin: cfg.ownerQQ,
      ownerName: cfg.ownerName || '主人',
      contextBlocks: [],
      materials: ctx.materials.items,
      candidates: ctx.candidates,
      selected,
      pending: state.pending,
      history: state.history,
      stats: ctx.materials.stats,
      drives: ctx.drives,
    }) + `\n6) 这一轮不能用任何工具：直接输出你要发的那句话即可（会自动转发给${cfg.ownerName || '主人'}）。不想说就整段只输出 ${SILENCE}。`
  }

  // ---------- 生成 + 投递 + 回执（hub.deliver 内部吞错，成功判定看返回值） ----------
  async function runOnce({ reason = '定时', config, state, force = false } = {}) {
    const cfg = getConfig()
    const now = Date.now()
    ensurePurposeDay(state, now)
    const ctx = prepare(cfg, config, state, now)
    state.drives = ctx.drives
    state.drivesAt = now
    state.goals = ctx.goals
    state.observations = ctx.observations

    const hasEnough = ctx.materials.items.length >= config.minMaterials
      || state.pending.length > 0 || ctx.persona.hasText
    if (!hasEnough) {
      markPurposeSkip(state, { now, reason: 'materials', nextFireAt: planNextFire({ now, config, lastRunAt: state.lastRunAt, countToday: state.countToday }) })
      saveState(state)
      log.info?.(`目的（${reason}）：素材太少，改约下一次`)
      return { outcome: 'skipped-materials' }
    }

    const picked = selectPurpose({
      seeds: ctx.seeds, goals: ctx.goals, pending: state.pending, history: state.history,
      config, drives: ctx.drives, now, lastMasterAt: ctx.lastMasterAt,
    })
    state.lastMaterialCount = ctx.materials.items.length
    state.lastCandidateCount = picked.candidates.length
    if (!picked.purpose) {
      markPurposeSkip(state, { now, reason: 'no-candidate', nextFireAt: planNextFire({ now, config, lastRunAt: state.lastRunAt, countToday: state.countToday }) })
      saveState(state)
      log.info?.(`目的（${reason}）：这轮没选出目的，改约下一次`)
      return { outcome: 'skipped-no-candidate' }
    }

    const prompt = promptFor(cfg, config, picked.purpose, { ...ctx, candidates: picked.candidates }, state, now)
    // 投递即占今日次数（模型回合已经花钱了）；引擎随后按真结局结算
    markPurposeDelivered(state, { now, planned: picked.purpose })
    saveState(state)

    let raw = ''
    let genError = null
    try {
      log.info?.(`目的（${reason}）：${picked.purpose.text}`)
      raw = typeof hub.runPromptTurn === 'function'
        ? await hub.runPromptTurn(chatIdOf(cfg), prompt)
        : await hub.runSystemTurn('purpose', 'QQ · 主动搭话（目的回合）', prompt, { timeoutMs: 180000, noTools: true })
    } catch (error) {
      genError = error
      log.warn?.('目的：生成出错：', error?.message)
    }
    const memo = parsePurposeMemo(raw)
    const text = cleanReply(raw, roleOf(cfg))
    let outcome
    if (!text) {
      outcome = genError ? 'failed' : 'silent' // 模型有权跳过（【状态】跳过 / [沉默]），silent 不硬发
    } else {
      try {
        const r = await hub.deliver(chatIdOf(cfg), text, { own: true })
        outcome = r && typeof r === 'object' ? 'sent' : 'silent' // deliver 吞错只返回 undefined / {missedAt}
      } catch (error) {
        outcome = 'delivery-failed'
        log.warn?.('目的：投递失败：', error?.message)
      }
    }
    applyPurposeOutcome(state, { now: Date.now(), config, outcome, text, memo, planned: picked.purpose })
    saveState(state)
    log.info?.(`目的：回合结束 ${outcome}（今天第 ${state.countToday} 次）`)
    return { outcome, text, memo }
  }


  // ---------- 追问（沿用旧 speakup 的「轻轻追一句」，不占今日次数） ----------
  async function maybeNudge(cfg, state, now = Date.now()) {
    const su = cfg.speakUp || {}
    if (!su.nudge) return false
    const lb = hub.lastBotToOwner || { at: 0, text: '' }
    const quietMs = now - (lb.at || 0)
    const flag = readJson(nudgeFile(), {})
    if (!lb.at || lb.at <= (hub.lastOwnerChatAt || 0)) return false
    if (flag.nudgedFor === lb.at) return false
    if (!/[？?]|吗|呢|嘛|没$/.test(String(lb.text || '').trim())) return false
    if (!(quietMs > 15 * MINUTE && quietMs < 40 * MINUTE)) return false
    writeJson(nudgeFile(), { nudgedFor: lb.at }) // 引擎状态文件会被 normalize 洗字段，追问标记单独存
    if (Math.random() >= 0.5) return true
    const idle = Math.round(quietMs / MINUTE)
    const owner = cfg.ownerName || '主人'
    const prompt = `【系统提醒，不是${owner}说的话】你刚才跟${owner}说「${String(lb.text || '').slice(-60)}」，${owner}已经 ${idle} 分钟没回了。可以轻轻追一句（比如「人呢」「睡着啦？」，或者换个话题），别催、别抱怨；觉得${owner}在忙就只回 ${SILENCE}。这一轮不能用工具，直接输出那句话。`
    try {
      const raw = typeof hub.runPromptTurn === 'function'
        ? await hub.runPromptTurn(chatIdOf(cfg), prompt)
        : await hub.runSystemTurn('purpose-nudge', 'QQ · 主动搭话（追问）', prompt, { timeoutMs: 120000, noTools: true })
      const text = cleanReply(raw, roleOf(cfg))
      if (text) await hub.deliver(chatIdOf(cfg), text, { own: true })
    } catch (error) {
      log.warn?.('目的：追问出错：', error?.message)
    }
    return true
  }

  // ---------- 对外 ----------
  async function tick() {
    const cfg = getConfig()
    const config = purposeConfig(cfg)
    if (!config.enabled || !cfg.ownerQQ) return
    const chatId = chatIdOf(cfg)
    if (isMuted?.(chatId)) return
    const now = Date.now()
    const state = loadState(config, now)
    if (await maybeNudge(cfg, state, now)) return
    const env = {
      enabled: true, modeOk: true, dshReady: true, paused: false, ownerAllowed: true,
      busy: false, friendOk: true, budgetBlocked: false, // QQ Hub 无 token 预算/好友探测服务，恒可用（留 env 位）
      ownerIdleMs: now - lastPrivateAt(cfg),
    }
    const verdict = evaluatePurposeTick({ now, config, state, env })
    if (verdict.action !== 'run') {
      if (verdict.reason !== 'waiting') markPurposeSkip(state, { now, reason: verdict.reason, nextFireAt: verdict.nextFireAt || state.nextFireAt })
      saveState(state)
      return
    }
    await runOnce({ reason: '定时', config, state })
  }

  /** 手动触发（面板「现在就让她来找我」）：跳过排程类闸门，不跳过总开关/禁言。 */
  async function fire(reason = '手动') {
    const cfg = getConfig()
    const config = purposeConfig(cfg)
    if (!config.enabled) return { outcome: 'disabled' }
    if (isMuted?.(chatIdOf(cfg))) return { outcome: 'muted' }
    if (!cfg.ownerQQ) return { outcome: 'no-owner' }
    const state = loadState(config)
    return runOnce({ reason, config, state, force: true })
  }

  /** 同步返回（host.js:401 / 概览页依赖），至少含 count。 */
  function state() {
    const s = readJson(stateFile(), null)
    const normalized = normalizePurposeState(s)
    return {
      count: normalized.countToday,
      countToday: normalized.countToday,
      day: normalized.day,
      nextFireAt: normalized.nextFireAt,
      lastOutcome: normalized.lastOutcome,
      lastPurpose: normalized.lastPurpose,
    }
  }

  /** 面板摘要（不含提示词全文）。 */
  function status() {
    const config = purposeConfig(getConfig())
    // config 里挑几个调参值一并返回：面板要显示「实际生效」的参数（minMaterials/maxCandidates 等不在 state 里）
    const sum = summarizePurposeState(loadState(config), { config })
    sum.minMaterials = config.minMaterials
    sum.maxCandidates = config.maxCandidates
    return sum
  }

  /** 零副作用预览：真收素材、真拼提示词，但不写状态、不生成、不投递。 */
  function preview() {
    const cfg = getConfig()
    const config = purposeConfig(cfg)
    const now = Date.now()
    const state = structuredClone(loadState(config, now))
    const ctx = prepare(cfg, config, state, now)
    const lastMasterAt = ctx.lastMasterAt
    const picked = selectPurpose({
      seeds: ctx.seeds, goals: ctx.goals, pending: state.pending, history: state.history,
      config, drives: ctx.drives, now, lastMasterAt,
    })
    const prompt = picked.purpose ? promptFor(cfg, config, picked.purpose, { ...ctx, candidates: picked.candidates }, state, now) : ''
    return {
      stats: ctx.materials.stats,
      materials: ctx.materials.items.map((m) => ({ kind: m.kind, source: m.source, who: m.who, text: m.text })),
      drives: ctx.drives,
      goals: ctx.goals.slice(0, 5).map((g) => ({ owner: g.owner, domain: g.domain, intent: g.intent, confidence: g.confidence, risk: g.risk, status: g.status })),
      candidates: picked.candidates.map((c) => ({ owner: c.goalOwner, need: c.need, action: c.action, text: c.text, confidence: c.confidence, risk: c.risk })),
      selected: picked.purpose && { text: picked.purpose.text, need: picked.purpose.need, action: pAction(picked.purpose), owner: picked.purpose.goalOwner, confidence: picked.purpose.confidence },
      prompt,
    }
  }
  const pAction = (p) => p.action || ''

  /** 每轮系统提示词里的驱动提示（零风险的提示层对接：只影响语气倾向，不改变工具与权限）。 */
  function drivesRule() {
    const cfg = getConfig()
    if (cfg.enabled === false) return ''
    if (!((cfg.ext && cfg.ext.purpose) || {}).enabled) return '' // 引擎没开就不往提示词里掺驱动
    const s = readJson(stateFile(), null)
    if (!s) return ''
    const drives = s.drives || {}
    const top = PURPOSE_NEEDS
      .map((need) => ({ need, label: NEED_LABELS[need] || need, score: Number(drives[need]) || 0 }))
      .filter((x) => x.score >= 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
    if (!top.length) return ''
    return `（你最近心里比较想要：${top.map((t) => t.label).join('、')}。它会自然影响你想聊什么，不用说出来。）`
  }

  return { tick, fire, state, status, preview, run: fire, drivesRule }
}
