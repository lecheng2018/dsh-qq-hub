// 当前唯一生产核心组装根。
//
// 全链：NormalizedInbound → SessionRegistry → TurnController → ContextAssembly → Outbox。
// 每一件都是 M2/M3 的独立模块，这里只做装配与接线（host 不承载业务规则——总览 §4）。
//
// dispatch 语义（与 legacy dispatchEvent 对齐）：
//   - message / message_sent → 合流入回合 → 执行（DSH 会话轮次）→ 回复经 outbox 投递；
//   - poke → 独立入站事件（segments=[poke]，消费方决定是否回应）；
//   - 命令（owner 斜杠命令）在 M4-2 由命令闸先截（回复 force 直发，同 legacy 语义）。
//
// 红线：物理发送只有 outbox 一个 owner；unknown 不自动重发；turn 执行尊重取消信号（诚实标记）。

import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'

import { legacyEventToNormalized } from '../chat/adapters/legacy-inbound.js'
import { createDshSessionAdapter } from '../chat/adapters/dsh-session.js'
import { createOnebotOutboxAdapter, paramsFor } from '../chat/adapters/onebot-outbox.js'
import { createLegacyContextAdapter } from '../chat/adapters/legacy-context.js'
import { resolveCharacterIdentity } from '../persona/identity-context.js'
import { createSessionRegistry } from '../chat/session-registry.js'
import { createSessionFileStore } from '../chat/session-store.js'
import { createSystemTurns } from '../chat/system-turns.js'
import { createTurnController } from '../chat/turn-controller.js'
import { createContextAssembly, createThreadProvider, createTimeScaleProvider, createAffectiveProvider, AFFECTIVE_PROVIDER_ID, TIME_SCALE_PROVIDER_ID, THREAD_PROVIDER_ID } from '../chat/context-assembly.js'
import { isChatKey } from '../chat/chat-key.js'
import { createOutbox } from '../chat/outbox.js'
import { createReplyDelivery } from '../chat/reply-delivery.js'
import { createThreadObserver } from '../chat/thread-wiring.js'
import { createInteractionState } from '../chat/interaction-state.js'
import { createOutbound } from '../chat/outbound.js'
import { createOutboundFiles } from '../chat/outbound-files.js'
import { createTurnParticipants } from '../chat/turn-participants.js'
import { createPresence } from '../chat/presence.js'
import { createCapture } from '../chat/capture.js'
import { createFaces } from '../chat/faces.js'
import { createDeliveryLedger } from '../chat/delivery-ledger.js'
import { isOwner, checkAllowed, levelFor, presetFor } from '../chat/access.js'
import { createActivityState } from '../chat/activity-state.js'
import { checkIdentityLeak } from '../chat/identity-guard.js'
import { parseMessageEvent, cardText, neutralizeInboundDsl } from '../chat/inbound.js'
import { parseCommand } from '../chat/commands.js'
import { createInboundImages } from '../chat/inbound-images.js'
import { createInboundVision } from '../chat/inbound-vision.js'
import { parseReply, replyRules, wantsVoice } from '../chat/reply.js'
import { defaultModel, pickReasoningEffort, modelVision } from '../core/llm.js'
import { resolveChatModel } from '../chat/chat-model.js'
import { personaIdFor } from '../persona/personas.js'
import { workspaceDirOf, workspaceDirForChat, WORKSPACE_TITLE } from '../chat/workspace.js'
import { createGroupState } from '../chat/group-state.js'
import { readJson, writeJson } from '../core/store.js'
import { policyFor, decideGroupReply, topicRelevance, withRoleWakeWords } from '../chat/group-policy.js'
import { createRepeatGate } from '../core/repeat-gate.js'
import { redact } from '../core/redact.js'
import { decideGroupReplyWithAtmosphere, gateFromEnv } from '../chat/group-atmosphere-gate.js'
import { assessFishDensity, assessPairLoop, dedupConvo, fishGuardReasonText, normalizeFishGuard, senderFish } from '../chat/fish-guard.js'
import { agoLabel, nowLine } from '../chat/clockline.js'
import { backfillNoticeBlock } from '../chat/backfill.js'
import { isBackfill } from '../chat/normalized-inbound.js'
import { readInboundFiles, inboundFileBlocks } from '../chat/inbound-files.js'
import { createInboundAudio } from '../chat/inbound-audio.js'
import { createQuotedMessages } from '../chat/quoted-messages.js'
import { createRatelimitMiddleware, ratelimitOptionsFromEnv } from '../kernel/mw-ratelimit.js'

/** 合并转发水合：展开真实消息正文，限制条数和总长度；失败保留原段，不伪称已读。 */
async function hydrateForwards(members, onebot, log) {
  const out = []
  for (const member of Array.isArray(members) ? members : []) {
    const segments = Array.isArray(member?.segments) ? member.segments : []
    if (!segments.some((s) => s?.type === 'forward')) { out.push(member); continue }
    const next = []
    for (const segment of segments) {
      if (segment?.type !== 'forward') { next.push(segment); continue }
      const id = String(segment.data?.id ?? segment.data?.res_id ?? segment.data?.forward_id ?? '')
      if (!id) { next.push(segment); continue }
      try {
        const raw = await onebot.call('get_forward_msg', { id }, { timeoutMs: 10000, retries: 0 })
        const rows = []
        let used = 0
        for (const item of (raw?.messages || []).slice(0, 50)) {
          const sender = item?.sender || {}
          const parsed = parseMessageEvent({
            message_type: 'private',
            user_id: item?.user_id ?? sender.user_id,
            sender,
            message: item?.message ?? item?.raw_message ?? '',
          }, '')
          const name = String(sender.card || sender.nickname || parsed.userId || '某人')
          const line = `${name}：${parsed.text || '（媒体/非文字消息）'}`
          if (used + line.length > 6000) break
          rows.push(line)
          used += line.length
        }
        if (!rows.length) throw new Error('转发内容为空')
        next.push({ type: 'text', data: { text: `[合并转发的聊天记录（${rows.length} 条）]\n${rows.map((line) => `  ${line}`).join('\n')}\n[转发结束]` } })
      } catch (error) {
        log?.debug?.(`合并转发读取失败（保留原段）：${error?.message || error}`)
        next.push(segment)
      }
    }
    out.push({ ...member, segments: next })
  }
  return out
}

/** 群消息里的图片/表情段要跟着这段上下文走：群闸可能不触发回合，等下一条
 *  文字才回，此时触发轮 members 里已经没有那张图了（真机：群里只剩「（图片/表情）」占位）。 */
const MAX_GROUP_MEDIA = 4
function mediaOfInbound(inbound) {
  return (Array.isArray(inbound?.segments) ? inbound.segments : [])
    .filter((s) => s?.type === 'image' || s?.type === 'mface')
    .slice(0, MAX_GROUP_MEDIA)
    .map((s) => ({ type: 'image', url: String(s.data?.url || s.data?.file || '') }))
}

/** 入站事件 → checkAllowed 需要的 msg 形状（从 ChatKey + sender 还原 kind/userId/groupId）。 */
function aclMsgFromInbound(inbound) {
  const chatKey = String(inbound?.chatKey ?? '')
  if (chatKey.startsWith('group:')) return { kind: 'group', userId: String(inbound?.sender?.userId ?? ''), groupId: chatKey.slice(6) }
  return { kind: 'private', userId: chatKey.slice(8), groupId: '' }
}

/** 段列表 → 纯文本（身份闸用；同 legacy sendSegments 的取词）。 */
function textOfSegments(segments) {
  return (Array.isArray(segments) ? segments : []).map((s) => {
    if (s?.type === 'text') return String(s?.data?.text || '')
    if (s?.type === 'file') return `[文件 ${s.data?.file_name || s.data?.name || s.data?.file || '未命名'}]`
    if (s?.type === 'record') return '[语音]'
    if (s?.type === 'video') return '[视频]'
    return ''
  }).join('')
}

/** 入站 → 模块中枢 activity 事件（等价 legacy hub.js:1583 那一发）。
 *  token-guardian 等模块的 activity 计数全挂在这个事件上；开旗后消息不走 hub，
 *  不补这一发它们永远收不到计数（验收报告「额外缺口」，真机实测 L0 batches 恒 0）。 */
function emitActivity(mods, inbound, { direct = false, owner = false } = {}) {
  try {
    const chatKey = String(inbound?.chatKey || '')
    if (!chatKey) return
    mods?.emit?.('activity', {
      kind: 'in',
      chatId: chatKey,
      userId: String(inbound?.sender?.userId || ''),
      nickname: String(inbound?.sender?.nickname || ''),
      text: textOfSegments(inbound.segments),
      direct,
      owner,
    })
  } catch { /* 计数是旁路，绝不打断主链 */ }
}

/** 入站 → DSH content 块（legacy 视图语义：文本段原样、图片段带 url/file、其余如实降级）。
 *  文本段一律先过 neutralizeInboundDsl（§4.3）：用户伪造的 <inner>/<voice>/<poke>/… 标签族
 *  在进模型上下文之前就中和成实体，不能冒充系统元数据。 */
function segmentsToContent(members) {
  const content = []
  for (const m of members) {
    for (const s of (m?.segments ?? [])) {
      if (s?.type === 'text') { const t = neutralizeInboundDsl(String(s.data?.text ?? '')); if (t) content.push({ type: 'text', text: t }) }
      else if (s?.type === 'image' || s?.type === 'mface') content.push({ type: 'image', url: String(s.data?.url || s.data?.file || '') })
      else if (s?.type === 'reply' || s?.type === 'at') continue
      else if (s?.type === 'forward') content.push({ type: 'text', text: '\n[合并转发（内容没拉到）]\n' })
      // 卡片文字也是用户可控的入站正文（攻击者发一张标题带 <inner>… 的卡片就能绕过去）：
      // 必须和中 Prose 一样走中和，让模型看到字面内容而不是可执行标签。
      else if (s?.type === 'json') content.push({ type: 'text', text: `\n${neutralizeInboundDsl(cardText(s.data?.data))}\n` })
      else if (s?.type === 'xml') content.push({ type: 'text', text: '\n[卡片消息]\n' })
      else if (s?.type) content.push({ type: 'text', text: `\n[${s.type}]\n` })
    }
  }
  return content
}

/**
 * @param {object} o
 * @param {object} o.dsh DSH 上下文（services.sessionController）
 * @param {{ call: Function }} o.onebot OneBot 客户端
 * @param {object} o.mods 模块中枢（contextFor / commands / use）
 * @param {object} o.getConfig / o.setConfig
 * @param {object} o.logger
 * @param {(text: string) => string} [o.personaText] 人格文本注入（装配 fragment，priority 最高）
 * @param {(inbound: object, view: object) => Promise<string|null>} [o.runCommand] owner 命令闸（返回回复文本或 null）
 * @param {string} [o.ledgerFile] 投递台账文件（提供则真实持久化；缺省 = 内存，测试用）
 * @param {string} [o.sessionStoreFile] 会话映射文件（提供则持久化 + 启动恢复；缺省 = 内存，测试用）
 * @param {string} [o.groupStateFile] 群刹车/话题状态文件（提供则持久化 + 启动恢复；缺省 = 内存，测试用）
 * @param {(text: string, chat: object) => number} [o.memoryScore] 话题相关度（同 hub memoryScore，缺省 0）
 * @param {(chatId: string) => boolean} [o.isMuted] 静音判定（真机审计 1.10：入口就要拦，关了嘴不等于停脑）
 * @param {(msg: {text: string, userId: string, chatId: string}) => boolean} [o.interceptInteraction]
 *   旁路指令桥接（真机审计 1.9：主人「通过 #1」批复审批 / 等待中的交互提问回答优先消费；命中即不进回合）
 * @param {(chat: object) => string|null} [o.personaTextFor] 按聊天人设（真机审计 1.2：persona.privates/groups
 *   专用卡按群生效；返回 null = 跟随全局人设）
 * @param {(chatId: string, who: string, text: string, uid?: string) => void} [o.logChat]
 *   聊天流水（真机审计：新核心不写 chatlog → 记忆整理/日记两条链无料；实测当天进站 5900、流水 12 行）
 * @param {(chatId: string, segments: Array, userId: string) => number|void} [o.collectInboundStickers]
 *   入站表情收集；返回暂存候选数供本轮提示
 * @param {(where: object) => Array<object>} [o.buildTools]
 *   模块工具生成器（与 legacy hub.mount 同一份）。新核心此前**完全没挂工具**，
 *   导致她连 qq_send_sticker / 记忆 / B站 / 群管都没有，只能拿 bash+curl 自己绕（真机实测）。
 * @param {() => number} [o.toolsGeneration] 模块代际（热重载后整套重挂，同 legacy issue #73）
 * @param {object} o.stickers 当前表情服务。
 * @param {object} o.tts 当前语音合成服务；回复编排经 reply-delivery 进入 Shared Outbox。
 * @param {Record<string, () => string>} [o.promptVars]
 *   宿主侧提示词变量兜底（qq_hub_persona / qq_hub_rules_private / qq_hub_rules_social）：
 *   热重载后根作用域注册可能已失效，缺了就报 unknown prompt variable → 整轮 error（实测）
 * @param {(k: 'received'|'sent'|'errors') => void} [o.onStats]
 *   面板统计（真机审计 1.11：开旗后进站/出站不经 legacy hub，统计以前恒为 0）
 * @param {(chatKey: string, segments: Array, userId: string) => void} [o.noteMedia]
 *   最近发来的图/表情登记（「把刚才那张存下来」类工具依赖它，真机审计 1.11）
 */
export function createModularCore({
  dsh, onebot, mods, getConfig, logger, log,
  personaText, runCommand, ledgerFile, sessionStoreFile, groupStateFile,
  memoryScore, isMuted, interceptInteraction, personaTextFor, onStats, noteMedia, promptVars, stickers, tts, buildTools, toolsGeneration, localApi, logChat, onResetChat, collectInboundStickers, availableModels, moduleHooks, markTurnAt, sharedOutbox, isSentMessage, inboundAudio, quotedMessages: sharedQuotedMessages, inboundImages: sharedInboundImages, inboundVision: sharedInboundVision,
  // 挂起线索账本（US-004 产出）。线索 provider 只认 peek(chatKey, o) 这一个契约，
  // 所以这里按依赖注入接：宿主把账本传进来，core 不 import 账本实现（零业务耦合）。
  // 未传 = 不注册这两个 provider（优雅降级），不会因缺账本而启动失败。
  threadLedger,
  // US-019 S2 慢思考判定实现（可选注入，测试用假模型；生产走默认的 judgeThreads）。
  threadJudge,
}) {
  const audio = inboundAudio || createInboundAudio({ onebot, dsh, localApi, log, getConfig })
  const quotedMessages = sharedQuotedMessages || createQuotedMessages({ onebot, getConfig, isSentMessage, log })
  const inboundImages = sharedInboundImages || createInboundImages({ onebot, dsh, log })
  const inboundVision = sharedInboundVision || createInboundVision({ dsh, log, inboundImages })
  const debug = (m) => { try { log?.debug?.(m) } catch {} }
  // 高频否定判定（群闸不回、ACL 拒绝）逐条打会把面板刷爆（真机 2026-11-14 反馈）。
  // 经去重闸：签名变化立刻打、同款一个窗口只补一条汇总。见 src/core/repeat-gate.js。
  const repeatLog = createRepeatGate({ windowMs: 300_000 })
  const gatedDebug = (gateKey, sig, line) => {
    const r = repeatLog(gateKey, sig)
    if (r.emit) debug(r.suppressed > 0 ? `${line}（同款判定已静默 ${r.suppressed} 条）` : line)
  }
  // 「正在输入」状态机与 legacy 同一份（activity-state：私聊 + enabled + 非 dryRun 才亮，15s 续 ping、6 分钟封顶）
  const activity = createActivityState({ onTypingPing: () => {} })
  const pingTyping = (userId) => { try { Promise.resolve(onebot?.call?.('set_input_status', { user_id: Number(userId), event_type: 1 }, { timeoutMs: 5000 })).catch(() => {}) } catch {} }

  // cordis 的 ctx.services / ctx.attachments / agent.ctx.contexts 都是「未声明 inject 直接点会抛」的
  // getter（真机报告 3/4：`cannot get property "…" without inject`，可选链 `?.` 挡不住 getter 求值）。
  // 一律走 ctx.get(...)（宿主已 inject 的服务名），拿到就 try/catch 兜住。
  const ctxGet = (name) => { try { return dsh?.get?.(name) ?? null } catch { return null } }

  /** 群名缓存 + 按需查一次（legacy groupName 同语义：查不到就退群号，绝不为命名卡住主链）。 */
  const groupNames = new Map()
  async function groupNameOf(gid) {
    const id = String(gid || '')
    if (!id) return id
    if (groupNames.has(id)) return groupNames.get(id)
    try {
      const info = await onebot.call('get_group_info', { group_id: Number(id) }, { retries: 0 })
      if (info?.group_name) groupNames.set(id, String(info.group_name))
    } catch { /* 查群名是锦上添花：失败就退回群号 */ }
    return groupNames.get(id) || id
  }
  /** 预取白名单群的群名：建会话/回填时命名更准。 */
  function prefetchGroupNames() {
    const ids = (() => { try { return (getConfig().allow?.groups || []).map(String) } catch { return [] } })()
    Promise.resolve().then(async () => { for (const gid of ids) await groupNameOf(gid) }).catch(() => {})
  }

  const inboundRateLimit = createRatelimitMiddleware({ ...ratelimitOptionsFromEnv() })
  function rateAllowed(inbound) {
    const key = `${inbound.chatKey}:${String(inbound?.sender?.userId || '')}`
    try { return inboundRateLimit.take(key) } catch { return true }
  }

  // ---------- 群回复闸（真机审计 §1）：复用 legacy 的纯函数与状态模块，不另起一套策略 ----------
  // 群刹车/话题状态（said/interjects/engaged）提供文件则落盘 + 启动恢复，缺省纯内存（测试用）。
  const groups = createGroupState(groupStateFile ? {
    storage: {
      read: () => readJson(groupStateFile, () => ({})),
      write: (value) => writeJson(groupStateFile, value),
    },
    log,
  } : {})
  const interaction = createInteractionState()
  const participants = createTurnParticipants({ getConfig, chatOfSession: chatKeyOfSession })
  const presence = createPresence()
  const capture = createCapture()
  const faces = createFaces({ onebot, log })
  const sentIds = new Set()
  let selfId = ''
  const reportTurns = new Map()
  const pairCalmUntil = new Map()
  const pairCalmSweep = (now) => {
    if (pairCalmUntil.size < 50) return
    for (const [key, until] of pairCalmUntil) if (until < now - 3 * 3600_000) pairCalmUntil.delete(key)
  }
  const pendingMode = new Map() // chatKey → 决定本轮的 mode（interject/engaged/must），execute 消费
  const steeringChats = new Set() // 只在 DSH 生成期接受 steer；出站期的新消息排下一轮
  const timedOutChats = new Set() // 超时时保留映射；下一条消息到来再归档重建
  const sessionTurns = new Map() // sessionId → 这个会话已经跑过多少回合（会话轮换用）
  const oversizedChats = new Set() // 服务端拒绝请求体过大（413/插件内存上限）；下一条消息到来再归档重建
  const backfillMeta = new WeakMap() // inbound → 网关实测断线时长/最早消息年龄
  const stickerPicks = new WeakMap()
  const stickerHint = (n) => `（这轮里夹着 ${n} 张表情，是你自己看到的。有中意的就用 qq_collect_sticker ${n > 1 ? `1~${n}` : '1'} 收进自己库；收表情是你自己的小爱好，不用每张都跟对方说，偶尔提一句也行。）`
  // 群聊张力门禁（US-011）：装配期读一次 env（改完需重启，与其它旋钮同款口径）。
  // 默认关闭；非法/空值 fail-closed 回退 legacy（reason 带出来便于排障）。
  const atmosphereGate = gateFromEnv(process.env)
  if (atmosphereGate.enabled) log.info(`群聊张力门禁已开启（tensionLimit=${atmosphereGate.tensionLimit}）：高张力且未被叫到时不插嘴`)
  // 从未设置（raw=null）是默认态：每次重启都刷「未设置，按 legacy 处理」纯属噪音，不打。
  // 只有「显式关闭」或「值设坏了被兜底」才值得留一行——那是运维该知道的异常。
  else if (atmosphereGate.raw !== null) debug(`群聊张力门禁关闭：${atmosphereGate.reason}`)

  /**
   * 群消息要不要回：与 legacy 同一 decideGroupReply 调用形状。
   * 门禁只在这一处接：第 1/2/4 步仍是 decideGroupReply 本身，
   * 开关关时返回值与改造前逐字段一致。
   */
  function decideGroupReplyFor({ chatKey, text, mentioned, userId, repliedToBot = false }) {
    const cfg = getConfig()
    const now = Date.now()
    const gid = chatKey.slice(6)
    const pol0 = policyFor(cfg.group, cfg.group?.overrides, gid)
    // 唤醒词不只认配置里那几个固定词：她自己卡上的名字也该叫得动，
    // 否则换了卡就变成「在群里喊她新名字没反应」——和身份中枢认的名字劈叉。
    const pol = withRoleWakeWords(pol0, resolveCharacterIdentity(`group:${gid}`, cfg))
    const recentTexts = groups.buffer(gid).filter((x) => now - x.t < pol.activeWindowSec * 1000).slice(-6).map((x) => x.text)
    let memScore = 0
    try {
      const memChat = { chatId: chatKey, kind: 'group', groupId: gid }
      memScore = typeof memoryScore === 'function' ? memoryScore(recentTexts.join(' '), memChat) : 0
    } catch { memScore = 0 }
    const decision = decideGroupReplyWithAtmosphere({
      messages: groups.buffer(gid),
      policy: pol,
      relevance: topicRelevance(recentTexts, pol.interests, memScore),
      engagedUntil: groups.engagedUntil(gid),
      // engaged 连聊预算的两路输入：已接条数 + 入场时刻（group-policy 封顶）
      engagedReplies: groups.engagedReplies(gid),
      engagedSince: groups.engagedSince(gid),
      mentioned: !!mentioned,
      repliedToBot: !!repliedToBot,
      fromOwner: isOwner(cfg, userId),
      text,
      now,
      hour: new Date().getHours(),
      recentTimes: groups.buffer(gid).map((x) => x.t),
      interjectTimes: groups.interjectTimes(gid),
      botReplyTimes: groups.speakTimes(gid),
    }, { gate: atmosphereGate })
    // 氛围快照只在门禁开启时存在：进日志，排障时能直接看到「为什么没插嘴」。
    if (decision.atmosphere) debug(`群 ${gid} 氛围：张力 ${decision.atmosphere.tension.toFixed(2)}、热度 ${decision.atmosphere.energy.toFixed(2)}（${decision.atmosphere.advice}）`)
    return decision
  }
  /** ChatKey + 首发言者 → legacy 兼容的 chat 视图（provider / 人设 / 模型判定共用）。 */
  function chatViewFor(chatKey, members) {
    const key = String(chatKey || '')
    if (key.startsWith('group:')) {
      const lead = members?.[0]
      return { kind: 'group', chatId: key, groupId: key.slice(6), userId: String(lead?.sender?.userId ?? ''), nickname: String(lead?.sender?.nickname || '') }
    }
    return { kind: 'private', chatId: key, groupId: '', userId: key.slice(8), nickname: String(members?.[0]?.sender?.nickname || '') }
  }

  const selectedModels = new Map()
  const modelKey = (target) => target ? `${target.provider}::${target.model}::${target.reasoningEffort || ''}` : ''
  function selectModel(chat) {
    const cfg = getConfig()
    const base = defaultModel(dsh, cfg)
    let sel = base ? { provider: base.provider, model: base.model, reasoningEffort: cfg.model?.reasoningEffort || '' } : null
    const specific = resolveChatModel(cfg, chat, typeof availableModels === 'function' ? availableModels() : null)
    if (specific) sel = { provider: specific.provider, model: specific.model, reasoningEffort: specific.reasoningEffort || cfg.model?.reasoningEffort || '' }
    if (typeof moduleHooks?.model === 'function') sel = moduleHooks.model(sel, chat) ?? sel
    return sel?.provider && sel?.model ? sel : null
  }
  async function resolveTarget(chat) {
    const sel = selectModel(chat)
    if (!sel) return null
    const target = { provider: sel.provider, model: sel.model }
    const effort = await pickReasoningEffort(dsh, target.provider, target.model, sel.reasoningEffort || undefined)
    if (effort) target.reasoningEffort = effort
    return target
  }
  async function applySessionModel(agent, sessionId, target) {
    const ctrl = ctxGet('sessionController')
    const select = ctrl?.agents?.selectForNextRequest
    let result
    if (typeof select === 'function') result = await select.call(ctrl.agents, agent, target)
    else if (typeof agent?.session?.append === 'function') result = await agent.session.append('model/selection', target)
    else return false
    if (result === false) return false
    selectedModels.set(String(sessionId), modelKey(target))
    return true
  }

  // ---------- 图片进历史的预算（按会话累计） ----------
  // 服务端对「会话累计上下文 + 图片字节」有硬上限（真机 2026-11-19：413 plugin_request_too_large，
  // 请求约 5.8 MiB、插件内存上限 64 MiB）。关键点：图片块一旦进历史，**之后每一轮都会重新发一遍**，
  // 所以额度得按会话累加着算 —— 每轮重置等于没管。
  //
  // 额度用完后的新图不再进上下文，只留一句占位文字（不说「看不到」是骗人：确实没带进去）。
  // 计数在 admit 之前累加（fail-closed）：admit 失败时那几张图也不会进历史，多算一点更安全。
  //
  // 已知边界：计数在内存里、按 sessionId 记；插件热重载/重启后从 0 重新算（历史里的图说不清大小）。
  // 所以它只是「延缓增长」，兜底仍然是 413 自愈换会话。
  const imageBudget = new Map() // sessionId → { images, bytes }
  const IMAGE_BLOCK_DEFAULT_BYTES = 400 * 1024 // 只有 http(s) 地址、还没下载的图，按 400 KB 估
  const imageBlockBytes = (block) => {
    // 未下载的入站图分两种：已带 data（测试/本地已取字节）、url 是 base64://（内联）。两者都能算准；
    // http(s) 地址此刻还没取字节，只能估 —— 真实字节由 inbound-images 下载后才知道，这里不追着改。
    const encoded = typeof block?.data === 'string' && block.data
      ? block.data
      : typeof block?.url === 'string' && block.url.startsWith('base64://')
        ? block.url.slice('base64://'.length)
        : ''
    if (encoded) return Math.ceil(encoded.length * 3 / 4)
    const n = Number(block?.bytes)
    return Number.isFinite(n) && n > 0 ? n : IMAGE_BLOCK_DEFAULT_BYTES
  }
  /** 按会话额度裁掉超出的图片块；返回裁剪后的内容与本次计入的用量。 */
  function trimToImageBudget(content, sessionId, cfg) {
    const budgetCfg = cfg?.imageBudget
    if (!sessionId || budgetCfg?.enabled === false) return { content, added: { images: 0, bytes: 0 } }
    if (!Array.isArray(content) || !content.some((b) => b?.type === 'image')) return { content, added: { images: 0, bytes: 0 } }
    // 配置可能来自 normalize 之前（老配置文件 / 直接注入的 cfg）：缺字段时按默认额度来，
    // 绝不能因为「没写 imageBudget」就当成 maxImages=0 把所有图都裁掉（那等于凭空关掉看图能力）。
    const maxImages = budgetCfg?.maxImages === undefined ? 24 : Math.max(0, Number(budgetCfg.maxImages) || 0)
    const maxMiB = budgetCfg?.maxMiB === undefined ? 12 : Math.max(0, Number(budgetCfg.maxMiB) || 0)
    const maxBytes = maxMiB * 1024 * 1024
    const used = imageBudget.get(sessionId) || { images: 0, bytes: 0 }
    let images = used.images
    let bytes = used.bytes
    let dropped = 0
    const kept = []
    for (const block of content) {
      if (block?.type !== 'image') { kept.push(block); continue }
      const cost = imageBlockBytes(block)
      // 已经超了就别再加；额度足够才收（同一轮里多张图按顺序收，先到先得）
      if (images + 1 > maxImages || bytes + cost > maxBytes) { dropped++; continue }
      images++
      bytes += cost
      kept.push(block)
    }
    const added = { images: images - used.images, bytes: bytes - used.bytes }
    if (added.images > 0) imageBudget.set(sessionId, { images, bytes })
    if (!dropped) return { content: kept, added }
    kept.push({ type: 'text', text: `（这一轮有 ${dropped} 张图没带进上下文：本会话的图片额度用完了，只看得到文字。想让她看新图，可以让她重开一个会话。）` })
    return { content: kept, added }
  }
  /** 让一个会话的图片额度归零（换会话/重置时调用）。 */
  function resetImageBudget(sessionId) { if (sessionId) imageBudget.delete(String(sessionId)) }

  const admitContent = async (content, context = {}) => {
    const { content: trimmed } = trimToImageBudget(content, context.sessionId && String(context.sessionId), context.cfg || getConfig())
    return inboundVision.admit(trimmed, context)
  }

  const replyIdOf = (member) => String((member?.segments || []).find((s) => s?.type === 'reply')?.data?.id ?? '')
  const quotedInfo = (replyId, chatKey) => quotedMessages.get(replyId, chatKey)

  function quoteNote(q) {
    if (!q?.ok) return '（引用了某条消息，但内容没读到；如果影响理解，可以如实说没看到，让对方重发或说一下是哪条）'
    const owner = String(getConfig().ownerQQ || '')
    const who = q.isBot ? '你' : owner && q.uid === owner ? '主人' : `${q.who || q.uid || '某人'}${q.uid ? `(${q.uid})` : ''}`
    const body = String(q.text || '').replace(/\[(图片|表情包)\]/g, '').trim() || (q.media.length ? '（图片/表情）' : '（没有文字）')
    // 前缀用 `↳ 转述`：行内前情引用必须和「本条发言人在说」区分开。真机根因（2026-11-20）：
    // 引用正文挤进同一行后，模型读到了待回的内容，却按「这一行是谁发的」取编号，
    // 于是把对 A 的回应挂到 B 头上（`[20] o：5.3flash不好用` → 回给了 o，正文却答的是别人的 120token/s）。
    return `↳ 转述 ${who} 的话：「${body}」${q.media.length ? `，另有 ${q.media.length} 张图片/表情包` : ''}`
  }

  async function hydrateQuotes(members, chatKey) {
    const out = []
    for (const member of Array.isArray(members) ? members : []) {
      const replyId = replyIdOf(member)
      if (!replyId) { out.push(member); continue }
      const quoted = await quotedInfo(replyId, chatKey)
      const note = quoteNote(quoted)
      out.push({
        ...member,
        quoteNote: note,
        segments: [...(member.segments || []), { type: 'text', data: { text: `\n${note}` } }, ...quoted.media],
      })
    }
    return out
  }

  // ---------- Session Registry（DSH 适配；preset 走 legacy levelFor/presetFor 语义） ----------
  const systemTitles = new Map()
  const sessionAdapter = createDshSessionAdapter({
    dsh,
    // 会话标题（legacy hub.js titleFor 同语义，含真实群名）：新核心建完不命名，面板里全是「未命名」
    titleOf: async (chatKey) => {
      if (String(chatKey).startsWith('system:')) return systemTitles.get(String(chatKey)) || 'QQ · 后台'
      const cfg = getConfig()
      const owner = cfg.ownerName || '主人'
      if (String(chatKey).startsWith('group:')) return `QQ 群 · ${await groupNameOf(String(chatKey).slice(6))}`
      const uid = String(chatKey).slice(8)
      return uid === String(cfg.ownerQQ || '') ? `QQ · ${owner}私聊` : `QQ 私聊 · ${uid}`
    },
    // 会话必须带工作区，否则落到宿主 defaultCwd 直接 turn error（真机报告 5）；对齐 legacy ensureWorkspace
    ensureWorkspace: async (chatKey) => {
      try {
        const reg = ctxGet('workspaceRegistry') ?? dsh?.workspaceRegistry
        if (!reg) return undefined
        const dir = workspaceDirForChat(getConfig(), chatKey)
        try { mkdirSync(dir, { recursive: true }) } catch {}
        const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
        let ws = (reg.list?.() || []).find((w) => norm(w.path) === norm(dir))
        if (!ws && reg.create) ws = await reg.create(dir, WORKSPACE_TITLE)
        return ws
      } catch { return undefined }
    },
    presetOf: (chatKey) => {
      const cfg = getConfig()
      if (chatKey.startsWith('system:')) return { agentPreset: 'qq-hub-social' }
      if (chatKey.startsWith('group:')) return { agentPreset: 'qq-hub-social' } // 群永远 ≤ social
      // 私聊：按主人/档位映射 preset（非主人白名单 = social，绝不再冒完整能力档）
      const level = levelFor(cfg, { kind: 'private', userId: chatKey.slice(8) })
      return { agentPreset: presetFor(level, cfg) }
    },
  })
  const sessionPersonas = new Map()
  const currentPersona = (chatKey) => personaIdFor(chatViewFor(chatKey), getConfig())
  const baseSessionStore = sessionStoreFile ? createSessionFileStore({ file: sessionStoreFile }) : null
  const sessionStore = baseSessionStore && {
    load() {
      const entries = baseSessionStore.load()
      for (const [chatKey, entry] of Object.entries(entries)) {
        if (!entry?.sessionId) continue
        sessionPersonas.set(chatKey, { sessionId: String(entry.sessionId), personaId: entry.personaId || currentPersona(chatKey) })
      }
      return entries
    },
    save(entries) {
      const enriched = Object.fromEntries(Object.entries(entries).map(([chatKey, entry]) => {
        let persona = sessionPersonas.get(chatKey)
        if (!persona || persona.sessionId !== entry.sessionId) {
          persona = { sessionId: entry.sessionId, personaId: currentPersona(chatKey) }
          sessionPersonas.set(chatKey, persona)
        }
        return [chatKey, { ...entry, personaId: persona.personaId }]
      }))
      baseSessionStore.save(enriched)
    },
  }
  // 群名是异步查到的：建会话时可能还退着群号，拿到真名后补一次 rename（适配器内有去重，不会刷屏）。
  function refreshGroupTitles(reg) {
    Promise.resolve().then(async () => {
      for (const [chatKey, entry] of Object.entries(reg.snapshot?.() || {})) {
        if (!chatKey.startsWith('group:') || !entry?.sessionId) continue
        const gid = chatKey.slice(6)
        const name = await groupNameOf(gid)
        if (!name || name === gid) continue
        await sessionAdapter.renameExisting?.(entry.sessionId, chatKey).catch(() => {})
      }
    }).catch(() => {})
  }
  // 启动后给已有映射补标题（老映射是未命名时代建的）；无存量映射就不打网关查询
  const backfillTitles = (reg) => {
    Promise.resolve().then(async () => {
      const entries = Object.entries(reg.snapshot?.() || {}).filter(([, e]) => e?.sessionId)
      if (!entries.length) return
      prefetchGroupNames() // 先拿群名，回填才能用真名
      for (const [chatKey, entry] of entries) {
        await sessionAdapter.renameExisting?.(entry.sessionId, chatKey).catch(() => {})
      }
    }).catch(() => {})
  }
  const registry = createSessionRegistry({
    createSession: async (chatKey, hint) => {
      const personaId = currentPersona(chatKey)
      const created = await sessionAdapter.createSession(chatKey, hint)
      if (created?.sessionId) sessionPersonas.set(chatKey, { sessionId: String(created.sessionId), personaId })
      return created
    },
    ...(sessionStore ? { store: sessionStore } : {}),
    onError: (e) => log.warn('session 映射持久化异常：', e.message),
  })
  backfillTitles(registry)
  refreshGroupTitles(registry)
  const systemTurns = createSystemTurns({
    createSession: ({ key, title, noTools }) => {
      systemTitles.set(key, String(title || 'QQ · 后台'))
      return sessionAdapter.createSession(key, { agentPreset: presetFor(noTools ? 'chat' : 'social', getConfig()) })
    },
    resolveAgent: (sessionId) => ctxGet('sessionController')?.resolveAgent?.(sessionId),
    onEvent: (listener) => dsh.on?.('session/event', listener),
    archiveSession: (sessionId) => ctxGet('workspaceRegistry')?.archiveSession?.(sessionId),
    beforeTurn: async (agent, sessionId, { key, noTools }) => {
      const target = await resolveTarget({ chatId: key, kind: 'system', noTools })
      if (target) await applySessionModel(agent, sessionId, target)
    },
    log,
  })
  const turnAt = (chatKey) => registry.markTurn(chatKey)
  const sessions = () => Object.fromEntries(Object.entries(registry.snapshot()).map(([chatKey, entry]) => {
    let persona = sessionPersonas.get(chatKey)
    if (!persona || persona.sessionId !== entry.sessionId) {
      persona = { sessionId: entry.sessionId, personaId: currentPersona(chatKey) }
      sessionPersonas.set(chatKey, persona)
    }
    return [chatKey, { ...entry, personaId: persona.personaId }]
  }))
  /** 这个会话该不该退休：回合数或年龄任一超过阈值就算该换（填 0 的那一项不参与判定）。 */
  function sessionRetired(entry, cfg) {
    const rot = cfg?.sessionRotation
    if (!rot || rot.enabled === false) return ''
    const turns = sessionTurns.get(String(entry.sessionId)) || 0
    const maxTurns = Number(rot.maxTurns) || 0
    if (maxTurns > 0 && turns >= maxTurns) return `${turns} 轮（上限 ${maxTurns}）`
    const maxAgeMs = (Number(rot.maxAgeHours) || 0) * 3600_000
    const createdAt = Number(entry.createdAt) || 0
    if (maxAgeMs > 0 && createdAt > 0 && Date.now() - createdAt >= maxAgeMs) {
      return `会话已 ${Math.round((Date.now() - createdAt) / 3600_000)} 小时（上限 ${Math.round(maxAgeMs / 3600_000)} 小时）`
    }
    return ''
  }

  async function sessionForChat(chatKey) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await registry.sessionFor(chatKey)
      if (registry.peek(chatKey)?.sessionId !== entry.sessionId) continue
      let persona = sessionPersonas.get(chatKey)
      if (!persona || persona.sessionId !== entry.sessionId) {
        persona = { sessionId: entry.sessionId, personaId: currentPersona(chatKey) }
        sessionPersonas.set(chatKey, persona)
      }
      if (persona.personaId === currentPersona(chatKey)) {
        // 会话轮换：用太久/聊太多轮就归档重开。判在 sessionForChat 里是因为它是**每一轮的唯一入口**
        // （execute 与 runPromptTurn 都过这里），放别处会漏掉主动回合。
        // 放在人设判定之后：人设不对本来就该换，不必再谈退休。
        const retired = sessionRetired(entry, getConfig())
        if (retired) {
          log.info(`会话轮换：${chatKey} 的会话 ${String(entry.sessionId).slice(-8)} 已用 ${retired}，归档重开`)
          resetChat(chatKey)
          continue
        }
        sessionTurns.set(String(entry.sessionId), (sessionTurns.get(String(entry.sessionId)) || 0) + 1)
        return entry
      }
      resetChat(chatKey)
    }
    throw new Error(`人设变化过快，无法创建稳定会话：${chatKey}`)
  }

  // ---------- Context Assembly（模块上下文 + 人格 + 挂起线索 + 时空标尺） ----------
  // 线索/标尺 provider 声明 scope='global' 但内部 perChat：宿主只建一个全局实例，
  // 真正的聊天域由每次 assemble({ chatKey }) 带进来，并过 parseChatKey 校验。
  // 优先级：persona(1000) > 线索(800) > 时空标尺(790) > 关系温度(780) > legacy(100)。
  const threadProviders = threadLedger
    ? [
      createThreadProvider({ ledger: threadLedger, perChat: true, includeDormant: true }),
      createTimeScaleProvider({
        perChat: true,
        // 上次互动时间戳：优先用会话登记表的 markTurn 记录，缺失就不注入（不编造时间）
        // registry 没有 .get()，只读视图是 peek()；lastTurnAt 由 markTurn() 维护。
        // 注意时序：assemble（:781）早于 turnAt（:823），所以这里读到的确是**上一轮**的时间戳。
        resolveLastAt: (chatKey) => {
          try {
            const at = registry.peek(chatKey)?.lastTurnAt
            return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : undefined
          } catch { return undefined }
        },
      }),
    ]
    : []
  // US-015 · 关系温度：图谱模块算出的 tone 必须真的影响一句话。
  // - 惰性现取（mods.use 每次问一次）：模块关掉/热重载/被替换都不会踩到旧导出；
  // - perChat：作用域只来自本轮请求的 chatKey，群聊读群、私聊读私聊，物理上不可能串域；
  // - resolveTone 抛错由 provider 的 isolate 策略兜住，绝不影响其他 provider。
  const affectiveProvider = createAffectiveProvider({
    perChat: true,
    resolveTone: (chatKey) => {
      const mod = mods?.use?.(AFFECTIVE_PROVIDER_ID)
      if (!mod || typeof mod.toneFor !== 'function') return null
      return mod.toneFor(chatKey)
    },
  })

  const assembly = createContextAssembly({
    providers: [
      // 人设 fragment 必须跟 personaTextFor 同口径：专卡生效时卡已经通过 {{qq_hub_persona}} 进了
      // 系统提示词，这里若再把全局卡（personaText = persona.current）塞进 qq-hub-context，两张卡
      // 每轮打架，模型听后注入的那张——真机实测全局豆包卡压掉私聊小鲸鱼卡（2026-11-14）。
      // 专卡生效就返回空（装配层跳过空 fragment），跟随全局才给全局卡；群聊也因此省一份重复卡。
      ...(personaText ? [{
        moduleId: 'persona', priority: 1000, scope: 'global', cacheStable: true,
        provide: ({ chat }) => {
          if (typeof personaTextFor === 'function') {
            try { if (personaTextFor(chat)) return '' } catch { /* 读不到专卡就按全局口径注入 */ }
          }
          return personaText() || ''
        },
      }] : []),
      ...threadProviders,
      affectiveProvider,
      createLegacyContextAdapter({ mods, priority: 100 }),
    ],
  })

  // ---------- Outbox（唯一物理出口；授权/全局闸/身份闸/台账持久化全在此接线） ----------
  const ledger = !sharedOutbox && ledgerFile ? createDeliveryLedger({ file: ledgerFile, onError: (e) => log.warn('投递台账落盘异常：', e.message) }) : undefined
  const outbox = sharedOutbox || createOutbox({
    send: createOnebotOutboxAdapter({ onebot }).send,
    ...(ledger ? { ledger } : {}),
    // 出站白名单复核（与 legacy checkAllowed 同一判定；出队时执行，撤权在排队期间也生效）
    authorize: async (delivery) => {
      const cfg = getConfig()
      return checkAllowed(cfg, aclMsgFromInbound({ chatKey: delivery.chatKey })).allowed
    },
    // 全局 enabled/dryRun：出队时动态读（面板随时可改；不依赖入口快照）。truthy 语义与 legacy 一致。
    enabled: () => Boolean(getConfig().enabled),
    dryRun: () => Boolean(getConfig().dryRun),
    // 身份泄露闸：唯一出站点扫受保护 QQ/群号（同 legacy sendSegments 语义）
    guard: (delivery) => {
      const cfg = getConfig()
      const ig = cfg.security?.identityGuard || {}
      if (ig.enabled === false) return { ok: true }
      const text = textOfSegments(delivery.segments)
      const chatKey = String(delivery.chatKey || '')
      const ownGroup = chatKey.startsWith('group:') ? chatKey.slice(6) : ''
      const isPrivate = chatKey.startsWith('private:')
      return checkIdentityLeak(text, {
        surface: isPrivate ? '私聊消息' : '群消息',
        ids: [cfg.ownerQQ, cfg.botQQ].filter(Boolean),
        allowIds: [ownGroup, ...(isPrivate ? [cfg.ownerQQ] : [])].filter(Boolean),
        // 私聊只对「已知账号」与「QQ/群号+数字」把关；裸长数字不拦（技术文档/端口/ID 会误伤整篇报告）
        allowBareNumbers: isPrivate,
        mode: ig.mode === 'warn' ? 'warn' : 'block',
      })
    },
  })

  const deliveryContext = new AsyncLocalStorage()
  const bump = (kind) => { presence.bump(kind); try { onStats?.(kind) } catch {} }
  const outbound = createOutbound({
    getConfig, log, onebot, outbox, groups, stickers, tts, interaction, faces,
    hooks: moduleHooks, onStats: bump, deliveryContext,
    captureOnly: capture.captureOnly,
    onMessageSent: (result) => {
      const id = result?.message_id ?? result?.messageId
      if (id != null) {
        sentIds.add(String(id))
        if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value)
      }
    },
  })
  const outboundFiles = createOutboundFiles({ getConfig, log, outbox, sendSegments: outbound.sendSegments, captureOnly: capture.captureOnly, onStats: bump, deliveryContext })
  const replyDelivery = createReplyDelivery({
    deliveryContext,
    getConfig, log, hooks: moduleHooks, reportTurns, groups, stickers,
    interaction,
    // US-019：线索账本注入回复链路，用来处理 <inner> 里的【顺承前情】与闭环信号
    ...(threadLedger ? { threadLedger } : {}),
    ...outbound,
    logChat,
    onActivity: (event) => mods.emit?.('activity', event),
    onDelivered: (event) => presence.noteDelivered(event),
    outbox: () => outbox,
    isCaptured: capture.isCaptured,
  })

  // ---------- US-019 · 线索生产者（S1 规则层 + S2 慢思考层） ----------
  //
  // 接线位置说明（为什么在 modular-core 的轮末、而不是 reply-delivery 内部）：
  //   1. **顺序**：新线索必须在本轮 applyThreadContinuation（reply-delivery 内）**之后**入账。
  //      接在 reply-delivery 里会让同一轮的 advance() 把刚落地的 active 直接推成 extended
  //      （生下来就漏一轮）。轮末是唯一同时满足「已投递」和「未推进」的位置。
  //   2. **依赖**：S2 要 dsh（宿主模型）和 cfg，reply-delivery 这两样都没有、也不该有
  //      （它是纯投递编排，注入模型会让它变成第二个决策点）。
  //   3. **可测**：轮末调用点是 modular-core 的公开出口（simulateTurn/dispatch），
  //      e2e 能直接打；藏在 delivery 里就只能靠 deliver 单测旁证。
  // 默认只在私聊跑 S2（群里每人一句就一次模型调用，成本压不住；S1 规则层零成本照跑）。
  const threadObserver = threadLedger
    ? createThreadObserver({
      dsh,
      getConfig,
      ledger: threadLedger,
      log,
      ...(threadJudge ? { judge: threadJudge } : {}),
      // 裁剪节流跟着配置走（面板改完下一轮生效），默认 60 秒一次
      pruneIntervalMs: () => Number(getConfig()?.threads?.pruneIntervalMs) || undefined,
    })
    : null

  // ---------- Turn Controller（执行 = 会话轮次 + 装配 + 投递） ----------
  /** 群聊上下文拼接（真机审计 1.3；legacy groupPrompt 的简化复刻）：
   *  未投喂最近 20 条 + 已投喂 8 条，带发言人标记与相对时间；主人只标「主人」不落号码。
   *  引用正文由 quotedInfo 水合；<reply:n>/<at:> 与富媒体出站统一经当前 reply-delivery。 */
  function groupPromptContent(chatKey, members, previousTurnAt) {
    const gid = chatKey.slice(6)
    const buf = groups.buffer(gid)
    for (const m of (members || [])) {
      if (m?.quoteNote && m?.messageId) {
        const hit = buf.findLast?.((x) => String(x.mid) === String(m.messageId))
        if (hit) hit.quoteNote = m.quoteNote
      }
    }
    const fresh = buf.filter((x) => !x.fed).slice(-20)
    const older = buf.filter((x) => x.fed).slice(-8)
    // fed 不在这里标（缺陷：群缓冲静默丢消息）。旧版 `for (const x of buf) x.fed = true`
    // 有两个丢消息口子：① 一次把整段 buf 标 fed，突发超过 20 条时**未选中**的新消息也被
    // 标 fed，永远进不了上下文；② 标在 followup 之前，回合若在模型消费前失败，这些消息
    // 已 fed，下轮不再喂。现只把**选中的 fresh** 作为 fedItems 返回，由 execute 在拿到回复
    // （模型确实消费了这段输入）后才标 fed；失败路径不标 → 下轮重新作为 fresh 喂入。
    const mode = pendingMode.get(chatKey) || 'must'
    pendingMode.delete(chatKey)
    const nowAt = Date.now()
    const ownerQQ = String(getConfig().ownerQQ || '')
    // 昵称也是不可信原文：群昵称可被改成 `<inner>…</inner>`，它会拼进 `昵称(uid)：正文`
  // 前缀里，绕过「只中和 segments[].data.text」的全部 4 层。所以这里过一遍中和。
  const safeNick = (v) => neutralizeInboundDsl(String(v ?? ''))
  const whoOf = (x) => (ownerQQ && String(x.uid) === ownerQQ ? '主人' : `${safeNick(x.nick || x.uid)}(${x.uid})`)
    // 群缓冲里的 x.text 是入站原文，同样必须中和（同 §4.3 防线；否则伪造标签从群聊路径进上下文）。
    // 前情引用**挂在发言人那一块的下方**，用 `↳ 转述` 明确标出「这是别人的话」：
    //   ① 不脱出成提示词末尾的孤立段落（那会造成编号错位，见 2026-11-16 事故）；
    //   ② 也不挤进同一行（那会让模型把转述内容当成发言人自己说的，见 2026-11-20 事故）。
    const block = (x) => {
      const text = neutralizeInboundDsl(x.text)
      const head = `${whoOf(x)}${x.at ? '@了你' : ''}${agoLabel(x.t, nowAt)}：${text || (x.quoteNote ? '（本条没有正文，只在转述下面这条）' : '（图片/表情）')}`
      if (!x.quoteNote) return head
      return `${head}\n    ${neutralizeInboundDsl(x.quoteNote)}`
    }
    const name = groupNames.get(gid) || gid
    const hint = mode === 'interject' ? '（没人叫你。只有你对这个话题真有话说、能自然接上时才插一句：接着话题说，别突然开新话题；接不上就只回 [沉默]）'
      : mode === 'engaged' ? '（你刚才在参与这个话题。想接着聊就接着说，话题和你没关系了或没什么可说的就只回 [沉默]）'
      : '（有人在叫你，看完这一段再回）'
    const refs = {}
    const numbered = fresh.map((x, i) => {
      // nick 一并存进引用表：模型可以直接写 <reply:昵称> / <reply:QQ号> 而不必算编号
      // （行内有「↳转述」时按名字引用真正说话的人，比数编号不容易挂错人）。
      if (x.mid && x.mid !== '0') refs[i + 1] = { mid: x.mid, uid: x.uid, nick: safeNick(x.nick || x.uid), ...(ownerQQ && String(x.uid) === ownerQQ ? { owner: true } : {}) }
      return `[${i + 1}] ${block(x)}`
    })
    groups.setRefs(gid, refs)
    const timeHead = nowLine(nowAt, previousTurnAt, { what: '上一段消息' })
    const head = (older.length ? `【群聊 ${name}】之前在聊：\n${older.map(block).join('\n')}\n\n` : '') +
      `【群聊 ${name}】刚才新说的（${fresh.length} 条）${hint}\n${timeHead}\n${numbered.join('\n')}\n\n` +
      '把这一段当成整体来回：一般说一两句就好，回给最需要回的那个人或者整个话题，不要一条一条地挨个回。\n' +
      '若只看到「图片/表情」占位，或明确提示当前模型看不了图，不得猜图中的人物、动作或内容；可以回应已有文字，没什么可说就只回 [沉默]。\n' +
      '下方缩进一行、以「↳ 转述」开头的，是这条发言人在引用别人的原话：那句话的主人是「↳ 转述」后面写的那个名字，不是写这条消息的人。要回应转述里的内容，就引用它真正的主人；不确定是谁就干脆不引用，在正文里点名说。\n' +
      '大多数时候直接说就行。只有想专门接上面方括号标出的某一条新消息时，才在那句话开头写 <reply:…>，会以「引用回复」发出；一次最多引用一条。写法三选一，都认：\n' +
      '  · <reply:编号> —— 编号必须且只能是上面方括号里的数字，如 <reply:1>；\n' +
      '  · <reply:昵称> —— 昵称就是方括号后面那个名字，如 <reply:初恋>；同名多条时取他最近的一条；\n' +
      '  · <reply:QQ号> —— QQ 号就是名字后面括号里的数字，如 <reply:3129168299>。\n' +
      '括号说明里的数字、别人引用里的数字都不是编号，不要拿来当 <reply:…>。写错了不会挂错人，只会按普通消息发出去。\n' +
      '要 @ 某个人（对方会收到提醒），写 <at:QQ号>，QQ 号就是上面名字后面括号里的数字。'
    // 触发轮自身的图片一并附上；引用已由 quoteNote 挂在 block(x) 下方，不脱出做孤立段落。
    // 没触发回合的那几条群消息带的图也在这里补：群缓冲里挂着 image 块，否则她只看得到
    // 「（图片/表情）」文字，而触发轮 members 已经没有原始段可拼（真机：群里看不懂表情包）。
    const extras = []
    const seenMedia = new Set()
    let mediaCount = 0
    const addMedia = (block) => {
      const url = String(block?.url || '')
      if (!url || seenMedia.has(url) || mediaCount >= MAX_GROUP_MEDIA) return
      seenMedia.add(url)
      mediaCount++
      extras.push(block)
    }
    for (const m of members) for (const s of (m?.segments ?? [])) {
      if (s?.type === 'image' || s?.type === 'mface') addMedia({ type: 'image', url: String(s.data?.url || s.data?.file || '') })
      // 收进来的文件正文/文件名同属入站原文，同样要中和（§4.3 第四落点在 groupPromptContent）。
      // 注：这一层是**深度防御里的冗余层**——实测摘掉它测试全红不了，因为同一段文本
      // 已在 :759（源头整块中和）中和过、且 neutralizeInboundDsl 幂等，此处的二次调用
      // 结果完全相同。保留它是为了「extras 这一路将来若接入别处原文时仍有兜底」，
      // 不是为了让某项测试变红。真正被断言锁住的是 :759（见 P1-d4/P1-d5）。
      else if (s?.type === 'text' && s.data?.inboundFile) extras.push({ type: 'text', text: neutralizeInboundDsl(String(s.data.text || '')) })
      else if (s?.type === 'json') extras.push({ type: 'text', text: neutralizeInboundDsl(cardText(s.data?.data)) })
      else if (s?.type === 'xml') extras.push({ type: 'text', text: '[卡片消息]' })
      else if (s?.type && !['text', 'reply', 'at', 'forward'].includes(s.type)) extras.push({ type: 'text', text: `\n[${s.type}]\n` })
    }
    // 同一段群里、没单独触发回复的消息也带图：随缓冲条目一起交给模型，最多 4 张。
    // 取完即清，下一段 older 背景里不会把同一张图反复投喂。
    const triggerMemberIds = new Set(members.map((m) => String(m?.messageId || '')).filter(Boolean))
    for (const x of fresh) {
      // 触发轮自己的图已在上面从 members 拼过，别按 URL 再补一份。
      if (!triggerMemberIds.has(String(x.mid || ''))) for (const block of x.media || []) addMedia(block)
      delete x.media
    }
    const direct = fresh.filter((x) => x.direct)
    const directSenders = new Set(direct.map((x) => x.uid))
    const target = directSenders.size === 1 ? direct.at(-1) : null
    const autoReply = target ? { mid: target.mid, uid: target.uid } : null
    const query = fresh.map((x) => x.text).filter(Boolean).join('\n')
    const speakers = [...new Set(fresh.map((x) => String(x.uid)).filter(Boolean))]
    return { blocks: [{ type: 'text', text: head }, ...extras], mode, autoReply, query, speakers, fedItems: fresh }
  }
  // 上下文/人设挂载：agent 级一次性注册（legacy mount 同型），text 闭包每轮读最新
  // 键必须是**会话 id**：resolveAgent 每轮返回新的 agent 包装对象，用对象做键永远不命中
  const ctxBoxes = new Map() // sessionId -> { text }
  const ctxBound = new Set() // 已注册过 context 的 sessionId
  const personaBound = new Set() // 已注册过 persona 变量的 sessionId
  const ctxFallback = new Set() // 宿主已占用同名 context：退回「把背景拼进消息」
  const ctxFallbackDone = new Set() // 已经投过一次的会话（避免每轮重复注入）
  const activeChatBySessionId = new Map() // sessionId -> chatKey（即时反查，为人设变量/工具判定提供毫秒级保障）

  /** 每个会话挂一次模块工具（= legacy hub.mount 的工具部分；名字清单变了就整套重挂）。 */
  const mountedTools = new Map() // sessionId -> { agent, key, offs }
  const slowNoticeSent = new Set()
  function cleanupSession(sessionId) {
    const sid = String(sessionId || '')
    if (!sid) return
    const mounted = mountedTools.get(sid)
    if (mounted) {
      for (const off of mounted.offs) { try { off?.() } catch {} }
      mountedTools.delete(sid)
    }
    ctxBoxes.delete(sid)
    ctxBound.delete(sid)
    ctxFallback.delete(sid)
    ctxFallbackDone.delete(sid)
    activeChatBySessionId.delete(sid)
    selectedModels.delete(sid)
    slowNoticeSent.delete(sid)
    sessionTurns.delete(sid)
    resetImageBudget(sid) // 换会话 = 图片额度跟着归零（新会话历史里没有旧图）
    for (const key of personaBound) if (key === sid || key.startsWith(`${sid}::`)) personaBound.delete(key)
  }
  function mountTools(agent, chatKey, sessionId) {
    slowNoticeSent.delete(sessionId)
    if (typeof buildTools !== 'function') return
    const cfg = getConfig()
    const level = levelFor(cfg, aclMsgFromInbound({ chatKey }))
    if (level === 'chat') return // 系统会话不挂业务工具（同 legacy）
    const parts = String(chatKey).split(':')
    const chat = parts[0] === 'group'
      ? { chatId: chatKey, kind: 'group', groupId: parts[1], userId: '', nickname: '' }
      : { chatId: chatKey, kind: 'private', userId: parts[1], groupId: '', nickname: cfg.ownerName || '' }
    let tools = []
    try { tools = buildTools({ chat, level, sessionId }) || [] } catch (error) { debug(`工具生成失败：${error?.message || error}`); return }
    let gen = 0
    try { gen = typeof toolsGeneration === 'function' ? Number(toolsGeneration()) || 0 : 0 } catch { gen = 0 }
    let denied = []
    try { denied = moduleHooks?.deniedTools?.() || [] } catch {}
    const key = `${tools.map((t) => t.name).sort().join(',')}|gen:${gen}|deny:${[...denied].sort().join(',')}`
    const prev = mountedTools.get(sessionId)
    if (prev && prev.agent === agent && prev.key === key) return
    if (prev) for (const off of prev.offs) { try { off?.() } catch {} }
    const offs = []
    try {
      const off = agent.ctx?.tools?.restrict?.({ deny: denied })
      if (typeof off === 'function') offs.push(off)
    } catch (error) { debug(`联动工具屏蔽失败：${error?.message || error}`) }
    let already = 0
    let failed = 0
    for (const tool of tools) {
      let registration = tool
      if (tool.slow) {
        const { slow, ...base } = tool
        const notice = typeof slow === 'string' ? slow : '好，我这就去做，做完跟你说一声。'
        registration = {
          ...base,
          async execute(args, exec) {
            let fired = false
            const timer = setTimeout(() => {
              if (fired || slowNoticeSent.has(sessionId)) return
              fired = true
              slowNoticeSent.add(sessionId)
              Promise.resolve(outbox.request({
                chatKey, sourceModuleId: 'core',
                segments: [{ type: 'text', data: { text: notice } }],
              })).catch((error) => debug(`慢工具提示没发出去：${error?.message || error}`))
            }, 1500)
            timer.unref?.()
            try { return await tool.execute(args, exec) } finally { clearTimeout(timer) }
          },
        }
      }
      try {
        const off = agent.ctx?.tools?.register?.(registration)
        if (typeof off === 'function') offs.push(off)
      } catch (error) {
        const msg = String(error?.message || error)
        if (msg.includes('already registered')) {
          try {
            // 热重载保护：若会话作用域内残留同名工具，从作用域层强制移除旧登记项并重挂新实例
            const scope = agent.ctx?._scope || agent.ctx
            const layer = agent.ctx?.tools?.layers?.peek?.(scope)
            if (layer?.tools?.data?.has?.(tool.name)) {
              layer.tools.data.delete(tool.name)
              const offRetry = agent.ctx?.tools?.register?.(registration)
              if (typeof offRetry === 'function') {
                offs.push(offRetry)
                continue
              }
            }
          } catch {}
          already++
        } else {
          failed++
          debug(`工具 ${tool?.name} 挂载失败：${msg}`)
        }
      }
    }
    mountedTools.set(sessionId, { agent, key, offs })
    debug(`模块工具 → ${chatKey}：新挂 ${offs.length}、已存在 ${already}、失败 ${failed}（清单 ${tools.length} 个）`)
  }
  async function hydrateInboundFiles(members, chatKey) {
    const out = []
    for (const member of members) {
      const fileSegments = (member.segments || []).filter((segment) => segment?.type === 'file')
      if (!fileSegments.length) { out.push(member); continue }
      const memberChat = chatViewFor(chatKey, [member])
      const files = await readInboundFiles({
        kind: memberChat.kind, userId: memberChat.userId, groupId: memberChat.groupId, files: fileSegments,
      }, { onebot, workspaceDir: workspaceDirOf(getConfig()), log })
      if (files.length) log.info(`${chatKey} 收到 ${files.length} 个文件：` + files.map((file) => file.name).join('、'))
      out.push({
        ...member,
        segments: [
          ...(member.segments || []).filter((segment) => segment?.type !== 'file'),
          // 文件块是「抬头 + 正文」一整段，正文是纯入站原文：必须在源头就整块中和，
          // 否则换个下游渲染点（如私聊 steer）就漏出裸 DSL。此处与 groupPromptContent 的
          // inboundFile 落点构成双保险（neutralizeInboundDsl 幂等，不会二次转义）。
          ...inboundFileBlocks(files, member.sender?.nickname || memberChat.userId).map((block) => ({ type: 'text', data: { text: neutralizeInboundDsl(block.text), inboundFile: true } })),
        ],
      })
    }
    return out
  }
  function handleTurnTimeout(chatKey, timeoutMs, { notify = true } = {}) {
    timedOutChats.add(chatKey)
    const minutes = Math.max(1, Math.ceil(timeoutMs / 60000))
    log.warn(`回合超过 ${minutes} 分钟未结束：${chatKey}；已释放等待，下一条消息将新建会话`)
    if (!notify) return
    Promise.resolve(outbox.request({
      chatKey, sourceModuleId: 'core',
      segments: [{ type: 'text', data: { text: `刚才的回复超过 ${minutes} 分钟还没完成，我先停止等待了，这条旧回复不会再补发。你发下一条消息时我会重新开始。` } }],
    })).catch((error) => debug(`回合超时提示没发出去：${error?.message || error}`))
  }

  // ---------- 413 / 请求体过大自愈 ----------
  // DeepSeek 服务端对「会话累计上下文 + 图片字节」有一个按会话计的硬上限（真机 2026-11-19：
  // 413 plugin_request_too_large「本次对话上下文或图片过大……插件内存上限 64 MiB」）。这不是
  // 单次请求能靠删图救回的：旧会话的历史每轮都重放，超限后**之后每一轮都必然 413**，会话
  // 永久卡死。DSH 把 413 归类为 INVALID_REQUEST（不重试），turn/end 落 error，本轮「不发」。
  //
  // 唯一可靠的恢复 = 换新会话（归档旧的，下一条消息自动新建）。与 handleTurnTimeout 同款模式：
  // 这里只记标记 + 提示，真正 resetChat 在下一条消息进入 execute 时做（避免在回合失败路径里
  // 立刻归档——此刻事件监听还没走完，且用户可能正在面板里翻这个会话）。
  //
  // 识别口径（宁可多识别不漏判，因为误伤代价只是多一次归档重建）：
  //   · DSH 结构化失败码：turn/end reason.error.code === 'INVALID_REQUEST' 且 status === 413；
  //   · 服务端错误文案特征：plugin_request_too_large / 「上下文或图片过大」 / 「插件内存上限」；
  //   · 兜底：INVALID_REQUEST 且消息含 too large / 413（防服务端换措辞）。
  // DSH 会话修复（repair.ts）合成的 turn/end 不带 error 细节（只有 kind），那类不是 413，天然不命中。
  const OVERSIZE_MESSAGE_RE = /plugin_request_too_large|上下文或图片过大|插件内存上限|\b413\b|too\s+large/i
  // 服务端「请求体/会话累计过大」的**强特征**。这些词只可能来自「发出去的东西太大」，
  // 不可能来自「模型的 token 上下文窗口不够」，所以不看 code、不看 status 都成立。
  //
  // 为什么必须不看 code（真机 2026-11-20，同一个群连挂 6 轮）：
  //   该聊天的模型走 pi-ai 路由（第三方 OpenAI 兼容提供方），错误分类走 dsh-llm-pi-ai 的
  //   `isContextOverflow()`，而它把 Anthropic 的 /request_too_large/i 当「上下文溢出」——
  //   我们的 `plugin_request_too_large` **正好含这个子串**，于是被判成
  //   `CONTEXT_WINDOW_EXCEEDED`（pi-ai 路径还不填 status）。后果有两层：
  //     ① dsh-compaction-basic 见 code 就压缩重试。但压缩请求本身也要把同一份超大历史
  //        发给模型算摘要，所以它同样 413（真机 compaction/end 的 error 就是同一条 413）——
  //        摘要算不出来、历史字节一个没少，纯空转，还把「该换会话」拖到下一条消息；
  //     ② 本函数的旧口径要求 `INVALID_REQUEST` 或 `status === 413`，两个都不匹配，
  //        自愈一次没触发，会话就一直卡在同一个超限历史里。
  //   所以改成「文案优先」：只要出现这些强特征词就认定是请求体过大。
  const SERVER_OVERSIZE_TEXT = /plugin_request_too_large|request_too_large|context_too_large|请求体过大|上下文或图片过大|插件内存上限|request\s+body\s+too\s+large|payload\s+too\s+large/i
  function turnFailureLooksOversized(failure) {
    if (!failure || typeof failure !== 'object') return false
    const code = String(failure.code || '')
    const status = Number(failure.status) || 0
    const message = String(failure.message || '')
    if (status === 413) return true
    // 文案优先：不依赖 code/status（pi-ai 会把 plugin_request_too_large 误判成上下文超限）
    if (SERVER_OVERSIZE_TEXT.test(message)) return true
    if (code === 'INVALID_REQUEST' && OVERSIZE_MESSAGE_RE.test(message)) return true
    // 某些路径（repair 合成 / 旧宿主）没有 status，只有 message：特征词唯一性足够强
    if (!code && OVERSIZE_MESSAGE_RE.test(message) && /413|过大|too large|too_large/i.test(message)) return true
    return false
  }
  /** 回合因请求体过大失败：记标记、提示用户；下一条消息进入时自动归档重建会话。 */
  function handleOversizedTurn(chatKey, failure, { notify = true } = {}) {
    oversizedChats.add(chatKey)
    const detail = String(failure?.message || '').replace(/\s+/g, ' ').slice(0, 120)
    log.warn(`回合因请求体过大被服务端拒绝（413/插件内存上限）：${chatKey}${detail ? '：' + redact(detail) : ''}；下一条消息将新建会话`)
    if (!notify) return
    Promise.resolve(outbox.request({
      chatKey, sourceModuleId: 'core',
      segments: [{ type: 'text', data: { text: '这个会话攒的上下文和图片太多，服务端拒绝了（超过 64 MiB 上限），这轮没法回。你发下一条消息时我会自动重新开始（旧对话会归档，可以随时找回）；图片类内容也会少带一些。' } }],
    })).catch((error) => debug(`请求体过大提示没发出去：${error?.message || error}`))
  }
  // ---------- US-015 · 关系信号自动喂料 ----------
  // 一轮回复**投递之后**才结算：关系信号是"这段对话怎么样"的结论，回复没发出去就不该记分。
  // 三层防护，任何一层失效都只影响记分，绝不影响回复投递：
  //   1. 调用点包 try/catch（feed 自己也不抛，这里是第二道）；
  //   2. 模块关着 / 没导出 feed / 导出坏掉 → 静默跳过（只记 debug，不刷 warn）；
  //   3. 非法 chatKey → 连模块都不问，直接返回（图谱层也会 fail-closed）。
  // 冷却（同 chatKey 同 kind 10 分钟只算一次）由模块内部处理，core 不重复实现。
  //
  // 最近几轮的原始对话（只留文本，不落盘）：信号挖掘需要"多轮"与"对方已经拒绝过"这类跨轮证据，
  // 而这些证据只能来自真实对话，不能拿模块上下文（记忆/人设）冒充。每个聊天域独立一条环形缓冲。
  const RECENT_TURN_CAP = 6
  const recentTurns = new Map() // chatKey -> ['对方：…', '我：…'] 交替
  function noteRecentTurn(chatKey, userText, botText) {
    const key = String(chatKey || '')
    if (!key) return
    const lines = recentTurns.get(key) || []
    if (userText) lines.push(`对方：${userText}`)
    if (botText) lines.push(`我：${botText}`)
    recentTurns.set(key, lines.slice(-RECENT_TURN_CAP * 2))
  }
  function recentContextOf(chatKey) {
    const lines = recentTurns.get(String(chatKey || ''))
    return lines ? lines.join('\n') : ''
  }

  function feedAffectiveSignals({ chatKey, userText, botText, recentContext, now }) {
    try {
      if (!isChatKey(String(chatKey || ''))) {
        debug(`关系信号跳过：非法 chatKey ${JSON.stringify(String(chatKey || ''))}`)
        return null
      }
      const mod = mods?.use?.(AFFECTIVE_PROVIDER_ID)
      if (!mod || typeof mod.feed !== 'function') return null // 模块关着 = 正常降级，不是错误
      const out = mod.feed({ chatKey: String(chatKey), userText, botText, recentContext, now })
      if (out?.applied?.length) {
        debug(`关系信号 → ${chatKey}：` + out.applied.map((s) => `${s.kind}(${s.confidence})`).join('、'))
      }
      return out || null
    } catch (error) {
      // 绝不冒泡：记分失败不能把已经发出去的回复变成失败回合
      debug(`关系信号喂料失败（不影响投递）：${error?.message || error}`)
      return null
    }
  }

  const controller = createTurnController({
    log,
    maxQueue: Math.max(1, Number(process.env.QQHUB_MAX_QUEUE) || 50),
    merge: {
      waitMs: Number(getConfig().merge?.waitSec * 1000) || 2500,
      maxMs: Number(getConfig().merge?.maxSec * 1000) || 8000,
      groupWaitMs: Number(getConfig().merge?.groupWaitSec * 1000) || 5000,
      groupMaxMs: Number(getConfig().merge?.groupMaxSec * 1000) || 15000,
    },
    execute: async (turn, io) => {
      if (timedOutChats.delete(turn.chatKey)) resetChat(turn.chatKey)
      // 上一轮因 413 / 请求体过大失败：归档旧会话重建。旧历史每轮重放必然再 413，只有换会话能救。
      if (oversizedChats.delete(turn.chatKey)) {
        resetChat(turn.chatKey)
        log.info(`请求体过大自愈：${turn.chatKey} 的旧会话已归档，本轮用新会话回答`)
      }
      const chat = chatViewFor(turn.chatKey, io.members)
      const inGroup = chat.kind === 'group'
      const { sessionId } = await sessionForChat(turn.chatKey)
      activeChatBySessionId.set(String(sessionId), turn.chatKey)
      // 装配上下文时使用当前会话，避免重建人设后仍传入旧 sessionId。
      const { fragments } = await assembly.assemble({ chatKey: turn.chatKey, sessionId, chat })
      const queryText = textOfSegments(io.members.flatMap((m) => m.segments || []))
      // 回合说话人登记（speakersOf 的数据源；群聊记忆检索要用）
      try { participants.note(String(sessionId), (io.members || []).map((m) => String(m?.sender?.userId || '')).filter(Boolean), { chatId: turn.chatKey, queryText }) } catch {}
      // 3. 构造会话消息：群聊带整段缓冲上下文（真机审计 1.3），私聊用触发段本体
      let turnMode = null
      let autoReply = null
      // 本轮选中、待模型消费后才标 fed 的群缓冲条目（缺陷：群缓冲静默丢消息）。
      let groupFedItems = null
      let content
      // 真机审计 1.4：先把语音段转成文字，再拼内容（群/私聊两条路都受益）
      const expanded = await hydrateForwards(io.members, onebot, log)
      const heard = await audio.hydrateRecords(expanded)
      const heardWithFiles = await hydrateInboundFiles(heard, turn.chatKey)
      if (inGroup) {
        for (const member of heard) {
          const hit = groups.buffer(chat.groupId).findLast((x) => x.mid && x.mid === String(member.messageId || ''))
          if (hit) hit.text = textOfSegments(member.segments)
        }
      }
      const members = await hydrateQuotes(heardWithFiles, turn.chatKey)
      if (inGroup) {
        for (const member of members) {
          if (member?.quoteNote) {
            const hit = groups.buffer(chat.groupId).findLast((x) => x.mid && x.mid === String(member.messageId || ''))
            if (hit) hit.quoteNote = member.quoteNote
          }
        }
      }
      const previousTurnAt = turnAt(turn.chatKey)
      if (inGroup) {
        const gp = groupPromptContent(turn.chatKey, members, previousTurnAt)
        content = gp.blocks
        turnMode = gp.mode
        autoReply = gp.autoReply
        groupFedItems = gp.fedItems
        try { participants.note(String(sessionId), gp.speakers, { chatId: turn.chatKey, queryText: gp.query }) } catch {}
      } else {
        content = segmentsToContent(members)
        const source = `【私聊】${neutralizeInboundDsl(String(chat.nickname || chat.userId || ''))}(${chat.userId})：`
        const timeHead = nowLine(Date.now(), previousTurnAt)
        const index = content.findIndex((block) => block.type === 'text')
        if (index >= 0) content[index] = { ...content[index], text: `${source}\n${timeHead}\n${content[index].text || ''}` }
        else content.unshift({ type: 'text', text: `${source}\n${timeHead}\n` })
      }
      const stickerPick = io.members.reduce((count, member) => stickerPicks.has(member) ? stickerPicks.get(member) : count, 0)
      if (stickerPick) content.push({ type: 'text', text: stickerHint(stickerPick) })
      const recovered = io.members.filter((member) => isBackfill(member))
      if (recovered.length) {
        const earliest = Math.min(...recovered.map((member) => Number(member.timestamp) || Date.now()))
        const gaps = recovered.map((member) => Number(backfillMeta.get(member)?.gapMs)).filter((value) => value > 0)
        const ages = recovered.map((member) => Number(backfillMeta.get(member)?.earliestAgeMs)).filter((value) => value > 0)
        content = [{
          type: 'text',
          text: backfillNoticeBlock({
            gapMs: gaps.length ? Math.max(...gaps) : 120_000,
            count: recovered.length,
            earliestAgeMs: ages.length ? Math.max(...ages) : Math.max(0, Date.now() - earliest),
          }),
        }, ...content]
      }
      if (typeof moduleHooks?.prompt === 'function') {
        const next = await moduleHooks.prompt(content, {
          chat, sessionId, senderId: chat.userId, prevText: '', queryText: textOfSegments(io.members.flatMap((m) => m.segments || [])),
        })
        if (next == null) return null
        content = next
      }
      const ctxText = fragments.map((f) => f.content).join('\n')
      // 4. 驱动 DSH 会话轮次（resolveAgent → followup；steer 输入注册给后续转向）
      //    sessionController 只能走 ctx.get（真机报告 3：cordis 未声明 inject 的 .services 直接点会抛）
      const ctrl = ctxGet('sessionController')
      if (!ctrl?.resolveAgent) throw new Error('DSH 没有 sessionController（新核心无法驱动会话）')
      const resolved = await ctrl.resolveAgent(sessionId)
      const agent = resolved?.agent
      if (!agent?.followup) throw new Error(`会话 ${sessionId} 没有 agent.followup（适配缺口，如实失败）`)
      mountTools(agent, turn.chatKey, sessionId) // 模块工具（qq_send_*、记忆、B站、群管…）
      let activeSteers = 0
      io.onSteer(async (inbound) => {
        activeSteers++
        try {
          const expandedSteer = await hydrateForwards([inbound], onebot, log)
          const heardSteer = await audio.hydrateRecords(expandedSteer)
          const filesSteer = await hydrateInboundFiles(heardSteer, turn.chatKey)
          const quotedSteer = await hydrateQuotes(filesSteer, turn.chatKey)
          let steerContent = segmentsToContent(quotedSteer)
          const source = `【私聊】${neutralizeInboundDsl(String(inbound.sender?.nickname || inbound.sender?.userId || ''))}(${inbound.sender?.userId})：`
          const timeHead = nowLine(Date.now(), previousTurnAt)
          const index = steerContent.findIndex((block) => block.type === 'text')
          if (index >= 0) steerContent[index] = { ...steerContent[index], text: `${source}\n${timeHead}\n${steerContent[index].text || ''}` }
          else steerContent.unshift({ type: 'text', text: `${source}\n${timeHead}\n` })
          const stickerPick = stickerPicks.get(inbound)
          if (stickerPick) steerContent.push({ type: 'text', text: stickerHint(stickerPick) })
          const steerQuery = textOfSegments(inbound.segments)
          try { participants.note(String(sessionId), [String(inbound.sender?.userId || '')].filter(Boolean), { chatId: turn.chatKey, queryText: steerQuery }) } catch {}
          if (typeof moduleHooks?.prompt === 'function') {
            const next = await moduleHooks.prompt(steerContent, { chat, sessionId, senderId: chat.userId, prevText: '', queryText: steerQuery, steer: true })
            if (next == null) return
            steerContent = next
          }
          const admittedSteer = await admitContent(steerContent, {
            nickname: inbound.sender?.nickname || inbound.sender?.userId,
            hint: textOfSegments(inbound.segments), cfg: getConfig(), sessionId,
          })
          await agent.steer({ id: randomUUID(), role: 'user', content: admittedSteer, source: { kind: 'qq-hub' } })
        } finally {
          activeSteers--
          if (followupDone && !activeSteers) finishReply()
        }
      })

      // 4.5 模型跟随面板配置（真机报告 8）：不切的话会话会跑 DSH 默认模型——
      //     风格/成本不一致，纯文本模型还会连带把看图堵死。与 legacy applyModel 同款：
      //     只改本会话下一请求（selectForNextRequest），绝不动 DSH 全局默认。
      try {
        const target = await resolveTarget(chat)
        if (target) await applySessionModel(agent, sessionId, target)
      } catch (error) { debug(`模型选择未生效（用默认）：${error.message}`) }

      // 4.6 上下文与人设挂载（真机审计 1.1 第一层 + 1.2）：legacy 的 seam 是
      //     agent.ctx.systemPrompt.context()/variable()（hub.js:546/529）——宿主上
      //     `agent.ctx.get('contexts')` 取不到服务，此前投喂因此整段丢弃。改回同款通道，
      //     每个 agent 只注册一次，text 闭包每轮读最新（面板改动下一轮生效，同 legacy）。
      // 用 sessionId 做键：resolveAgent 每轮返回新的 agent 包装对象，对象键会导致「每轮都当第一次」
      // → 重复注册被宿主拒绝 → holder 不更新 → 上下文永远停在第 1 轮的内容（实测 warn 刷屏 + 上下文冻结）。
      const sidKey = String(sessionId)
      const sp = (() => { try { return agent.ctx?.systemPrompt } catch { return undefined } })()
      if (sp?.context) {
        let holder = ctxBoxes.get(sidKey)
        if (!holder) { holder = { text: ctxText }; ctxBoxes.set(sidKey, holder) }
        else holder.text = ctxText // 每轮都更新（面板/记忆改动下一轮生效，同 legacy）
        if (!ctxBound.has(sidKey)) {
          ctxBound.add(sidKey)
          try { sp.context({ name: 'qq-hub-context', order: 905, text: () => holder.text }) }
          catch (error) {
            ctxFallback.add(sidKey) // 宿主已注册同名（多为热重载残留）：改为拼进消息，保证内容送达
            debug(`qq-hub-context 已存在，改为随消息投喂：${error?.message || error}`)
          }
        }
      } else debug('宿主没有 systemPrompt.context 通道，本轮模块上下文只随装配产出留档（如实记录）')
      // 提示词变量兜底（真机实测：热重载后 {{qq_hub_rules_private}} 会变成 unknown → 回合直接 error）。
      // 每个会话尝试一次，失败不记「已绑定」，下一轮继续试。
      if (promptVars && typeof promptVars === 'object' && sp?.variable) {
        for (const [n, fn] of Object.entries(promptVars)) {
          // 人设交给下面的「按聊天人设」块注册（它要带 chat 作用域），这里别抢先占名
          if (n === 'qq_hub_persona' && typeof personaTextFor === 'function') continue
          const key = `${sidKey}::${n}`
          if (personaBound.has(key)) continue
          try { sp.variable(n, fn); personaBound.add(key) } catch { /* 宿主已有同名：下一轮再试 */ }
        }
      }
      // 宿主已占用同名 context（多为热重载残留）时的兜底：**每个会话只投一次**。
      // 会话历史会一直带着这一条，后面每轮再塞相当于把人设卡和记忆重复注入（真机实测：
      // 22 轮里每轮都带一整份角色卡，既费 token 又让她像在重新读档）。
      if (ctxFallback.has(sidKey) && ctxText && !ctxFallbackDone.has(sidKey)) {
        ctxFallbackDone.add(sidKey)
        content = [{ type: 'text', text: `【本聊天背景，供参考（不必复述）】\n${ctxText}` }, ...content]
      }
      if (typeof personaTextFor === 'function' && sp?.variable && !personaBound.has(sidKey)) {
        personaBound.add(sidKey)
        try {
          sp.variable('qq_hub_persona', () => {
            try { const t = personaTextFor(chat); if (t) return t } catch {}
            try { return personaText ? personaText() : '' } catch { return '' }
          })
        } catch (error) { debug(`人设变量已存在，沿用宿主里那份：${error?.message || error}`) }
      }

      // 5. 等**回合结束**（不是首个 assistant/message）：
      //    - assistant/message：跳过 interrupted 的部分内容，记下本 turn 文本（可能多条取最后）；
      //    - turn/end：completed 且有文本才 resolve；非 completed 如实失败（不发、释放调度槽）；
      //    - followup rejection：捕获，回合落定异常，finally 清理监听器（防句柄泄漏）。
      let off = null
      let followupDone = false
      let completion = null
      let finishReply = () => {}
      const cleanupListener = () => { try { off?.() } catch {} off = null }
      const replyPromise = new Promise((resolve, reject) => {
        let lastTurn = null
        let lastText = ''
        finishReply = () => {
          if (!completion) return
          cleanupListener()
          if (!completion.completed) {
            // 413 / 请求体过大：旧会话的历史每轮重放、之后必然继续失败 —— 记标记换新会话自愈，
            // 而不是只「如实失败」后让这个聊天永久卡死（真机 2026-11-19：服务端按会话计的 64 MiB 上限）。
            if (turnFailureLooksOversized(completion.failure)) handleOversizedTurn(turn.chatKey, completion.failure)
            reject(new Error(`回合未正常结束：${completion.kind || '?'}`))
            return
          }
          resolve(completion.text)
        }
        off = dsh.on?.('session/event', (session, ev) => {
          if (session?.id !== sessionId) return
          if (ev?.type === 'tool/call' && /^(bili_watch|heybox_(feed|watch|hot)|douyin_(watch|recent|browse)|qq_draw_image)$/.test(String(ev?.data?.name || ''))) {
            reportTurns.set(turn.chatKey, true)
            return
          }
          if (ev?.type === 'assistant/message') {
            const d = ev?.data || {}
            if (d.interrupted) return
            const t = (d.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
            if (t) { lastTurn = d.turn; lastText = t }
            return
          }
          if (ev?.type === 'turn/end') {
            reportTurns.delete(turn.chatKey)
            const d = ev?.data || {}
            completion = { completed: d.reason?.kind === 'completed', kind: d.reason?.kind, text: lastTurn === d.turn ? String(lastText || '') : '', failure: d.reason?.error || d.reason?.failure || null }
            if (followupDone) finishReply()
          }
        })
        if (typeof off !== 'function') {
          cleanupListener()
          reject(new Error('DSH 没有 session/event 流，无法取回复文本'))
        }
      })
      // 5.5 消息完整形状（真机报告 1：DSH agent-loop 的 isOwned(message) 读 message.source.kind，
      //     只传 {content} 会在 turn/start 后 8ms 以 error 结束）。对齐 legacy hub.js:1902。
      const admitted = await admitContent(content, {
        nickname: chat.nickname || chat.userId,
        hint: textOfSegments(io.members.flatMap((member) => member.segments || [])), cfg: getConfig(), sessionId,
      })
      const message = { id: randomUUID(), role: 'user', content: admitted, source: { kind: 'qq-hub' } }
      // followup 的 rejected promise 必须捕获：否则 unhandledRejection + 回合永久 running 占死该聊天调度槽
      // 「正在输入」对齐 legacy（hub.js:1903 起 / turn/end 停）：私聊、enabled/dryRun 门在 startTyping 内部；
      // 现网新核心此前不亮 typing（转正补齐的 e2e 平账项）。
      const turnTimeoutMs = Math.max(1, Number(getConfig().turnTimeoutMs) || 600_000)
      let turnTimer = null
      const timeoutPromise = new Promise((resolve, reject) => {
        turnTimer = setTimeout(() => {
          const error = new Error(`DSH 回合超过 ${Math.ceil(turnTimeoutMs / 1000)} 秒未结束；已释放等待，迟到回复不会投递`)
          error.turnTimedOut = true
          reject(error)
        }, turnTimeoutMs)
        turnTimer.unref?.()
      })
      const clearTurnTimer = () => { if (turnTimer) clearTimeout(turnTimer); turnTimer = null }
      activity.startTyping(String(sessionId), chat, getConfig(), pingTyping)
      steeringChats.add(turn.chatKey)
      const stopTyping = () => { try { activity.stopTyping(String(sessionId)) } catch {} }
      let followupError = null
      try {
        await Promise.race([agent.followup(message), timeoutPromise])
      } catch (error) {
        followupError = error
      }
      if (followupError) {
        clearTurnTimer()
        steeringChats.delete(turn.chatKey)
        cleanupListener() // 失败路径同样摘监听（报告 §4.5「finally 清理监听」）
        stopTyping()
        if (followupError.turnTimedOut) handleTurnTimeout(turn.chatKey, turnTimeoutMs)
        // followup 先于 turn/end 拒绝时（stream 非 200 起步即 413）：错误本身可能带 LlmError.failure
        //（HTTP status / code）。turn/end 路径之外唯一能拿到 status 的地方，同样要走自愈标记。
        if (turnFailureLooksOversized(followupError?.failure || followupError)) handleOversizedTurn(turn.chatKey, followupError?.failure || followupError)
        throw new Error(`DSH 回合执行失败：${followupError?.message || followupError}`)
      }
      followupDone = true
      if (!activeSteers) finishReply()
      let reply
      try {
        reply = await Promise.race([replyPromise, timeoutPromise])
        clearTurnTimer()
        steeringChats.delete(turn.chatKey)
        stopTyping()
      } catch (error) {
        clearTurnTimer()
        steeringChats.delete(turn.chatKey)
        cleanupListener() // turn/end 非 completed / 无事件流：摘除后如实失败（回合落 failed，槽释放）
        stopTyping()
        if (error.turnTimedOut) handleTurnTimeout(turn.chatKey, turnTimeoutMs)
        throw error
      }

      // 模型已确实消费这段群输入（拿到回复）→ 此刻才把选中的 fresh 标 fed。
      // 之前任何失败路径（followup 抛错、回合超时、turn/end 异常）都已 throw，不会走到这里，
      // 那些消息保持 unfed，下一轮重新作为 fresh 喂入，不静默丢（缺陷：群缓冲静默丢消息）。
      // 只标选中的 fresh（≤20），突发超量时未选中的新消息仍 unfed，留给下一轮。
      if (groupFedItems) for (const x of groupFedItems) x.fed = true

      // 6. 出站后处理（真机报告 6：不处理后处理链时 `|||` 字面外发）：
      //    stripReasoning、按 ||| 分气泡（maxBubbles 上限由 replyRules 收敛）、[沉默] 不说话——与 legacy 同一函数。
      if (!reply) return null
      if (typeof moduleHooks?.reply === 'function') {
        const next = await moduleHooks.reply(String(reply), { chatId: turn.chatKey, userText: textOfSegments(io.members.flatMap((m) => m.segments || [])) })
        if (next == null) return null
        reply = String(next)
      }
      const cfgOut = getConfig()
      const parsed = parseReply(reply, replyRules(cfgOut, turn.chatKey.startsWith('group:')))
      if (parsed.silent) return null
      let replyItems = parsed.items
      if (typeof moduleHooks?.items === 'function') {
        const next = await moduleHooks.items(replyItems, { chatId: turn.chatKey, text: String(reply), userText: textOfSegments(io.members.flatMap((m) => m.segments || [])) })
        if (next == null) return null
        replyItems = next
      }
      try {
        const delivered = await replyDelivery.deliver(turn.chatKey, reply, {
          own: true,
          topicMode: turnMode || undefined, // 续聊不刷新话题窗口的分派依据（见 reply-delivery）
          userText: textOfSegments(io.members.flatMap((m) => m.segments || [])),
          wantVoice: wantsVoice(textOfSegments(io.members.flatMap((m) => m.segments || []))),
          autoReply,
          refs: inGroup ? groups.refs(chat.groupId) : {},
        })
        if (inGroup) {
          try { if (turnMode === 'interject') groups.noteInterject(chat.groupId) } catch {}
        }
        // US-019 · 轮末挖线索：这一轮**已经投递完**（applyThreadContinuation 跑过）才入账。
        // fire-and-forget：S2 是一次额外的小模型调用，绝不能让它在投递链路上等
        // （等 = 用户已经看到回复了，可这一轮的 turn 还不算结束，调度槽被白占）。
        // recordTurn 内部全 try/catch，账本容量满也只记日志；flush() 供测试与退出时收尾。
        if (threadObserver) {
          try {
            const sentText = replyItems.flatMap((item) => (item.kind === 'mixed' ? item.parts : [item]))
              .filter((item) => item.kind === 'text' || item.kind === 'voice')
              .map((item) => item.value).join('|||')
            threadObserver.recordTurn({
              chatKey: turn.chatKey,
              userText: textOfSegments(io.members.flatMap((m) => m.segments || [])),
              replyRaw: String(reply || ''),
              replyText: sentText,
              recentText: [String(participants.prevTextOf(String(sessionId)) || ''), textOfSegments(io.members.flatMap((m) => m.segments || []))].filter(Boolean).join('\n'),
            }).catch(() => {})
          } catch (error) {
            log.warn(`线索生产接线失败：${error?.message || error}`)
          }
        }

        // US-015 · 回复已投递，才结算这一轮的关系信号（失败只记 debug，绝不影响投递结果）。
        // 文本口径 = 这一轮真正进模型的用户原话 + 她的回复；recentContext 是同一聊天域的最近几轮。
        const turnUserText = textOfSegments(io.members.flatMap((m) => m.segments || []))
        feedAffectiveSignals({
          chatKey: turn.chatKey,
          userText: turnUserText,
          botText: String(reply || ''),
          recentContext: recentContextOf(turn.chatKey),
          now: Date.now(),
        })
        noteRecentTurn(turn.chatKey, turnUserText, String(reply || ''))
        // 如实上报（缺陷：轮次级谎报）。过去这里无条件写 state:'sent'，
        // 于是「3 条气泡挂了 2 条」与「全成功」在调用方看来完全一样，台账里的
        // unknown/failed 也没人读得到。现在按 reply-delivery 的气泡级回执区分：
        //   · 全部拿到网关回执 → sent
        //   · 有气泡没拿到回执 → partial（已经发出去的不重发，避免重复说话）
        // attempted 为 0 的情况（整轮没有任何可发条目）保持 sent，与旧行为一致。
        const failed = Number(delivered?.failedCount) || 0
        const state = failed > 0 ? 'partial' : 'sent'
        if (failed > 0) {
          log.warn(`${turn.chatKey}：本轮投递归属 ${state}（${delivered?.delivered ?? '?'}/${delivered?.attempted ?? '?'} 条拿到回执）`)
        }
        return { state, via: 'reply-delivery', failedCount: failed, attempted: delivered?.attempted, delivered: delivered?.delivered }
      } catch (error) {
        log.warn(`回复发送失败：${error?.message || error}`)
        throw error
      }
    },
  })

  /** 聊天域消息入口（host dispatchEvent 的旗开分支）。 */
  async function dispatchLegacyEvent(ev) {
    selfId = String(ev.self_id || selfId || getConfig().botQQ || '')
    const cfg = getConfig()
    // 命令闸（M4-2）：主人斜杠命令先截，回复经 outbox（同 legacy：命令不进合流，总开关关着也处理）
    if (runCommand && ev.post_type === 'message') {
      const view = parseMessageEvent(ev, ev.self_id)
      const cmd = parseCommand(view.text, mods.commands())
      if (cmd && isOwner(cfg, view.userId)) {
        const reply = await runCommand(cmd, { ...view, chatId: view.chatId, nickname: cfg.ownerName || '主人', text: view.text })
        if (reply) {
          await outbox.request({
            chatKey: view.chatId,
            sourceModuleId: 'core',
            segments: [{ type: 'text', data: { text: String(reply) } }],
            force: true,
          })
          return { handled: 'command' }
        }
      }
    }
    const { inbound } = safeAdapt(ev, 'realtime')
    if (!inbound) return { handled: 'skipped' }
    return routeInbound(inbound, ev, 'realtime')
  }

  /** 兼容旧 hub.onMessage 的等待契约；网关实时分发仍使用上面的异步入口。 */
  async function dispatchLegacyEventSettled(ev) {
    const routed = await dispatchLegacyEvent(ev)
    if (!routed?.turnId) return routed
    const outcome = await controller.waitForTurn(routed.turnId)
    if (outcome?.error) throw outcome.error
    return { ...routed, result: outcome?.value }
  }

  /**
   * 入站主链（realtime/backfill 共用），顺序逐项对齐 legacy hub.onMessage：
   * ACL → 旁路指令 → 总开关 → 静音 → 群缓冲 → activity 计数 → 群回复闸 → offer。
   * （真机审计 1.9/1.10/§1：enabled=false 和静音必须**入口就拦**——不进回合不烧 token；
   *  activity 在闸之前发：相关模块的计数不受「要不要回」影响。）
   */
  function routeInbound(inbound, ev, source) {
    const isPoke = (inbound?.segments || []).some((s) => s?.type === 'poke')
    if (isPoke) {
      const self = String(ev.self_id || getConfig().botQQ || '')
      const poker = String(inbound.sender?.userId || '')
      if (String(ev.target_id || '') !== self || !poker || poker === self) return { handled: 'skipped' }
    }
    const hook = isPoke ? moduleHooks?.poke : moduleHooks?.message
    const continueInbound = () => {
      if (!isPoke) return routeInboundCore(inbound, ev, source)
      try { interaction.rememberPoker(inbound.chatKey, String(inbound.sender?.userId || '')) } catch {}
      try { if (!interaction.claimPoke(inbound.chatKey)) return { handled: 'poke-throttled' } } catch {}
      const poke = inbound.segments.find((s) => s?.type === 'poke')
      const action = String(poke?.data?.action || '')
      const suffix = String(poke?.data?.suffix || '')
      return routeInboundCore({
        ...inbound,
        segments: [
          { type: 'at', data: { qq: String(ev.self_id || getConfig().botQQ || '') } },
          { type: 'text', data: { text: ` [戳了戳你${action ? `：${action}${suffix}` : ''}]` } },
        ],
      }, ev, source)
    }
    if (typeof hook !== 'function') return continueInbound()
    const input = isPoke ? ev : { ...parseMessageEvent(ev, ev.self_id), raw: ev }
    return Promise.resolve(hook(input)).then((claimed) => claimed ? { handled: 'module' } : continueInbound())
  }

  function routeInboundCore(inbound, ev, source) {
    const cfg = getConfig()
    // 入站 ACL：白名单外会话 offer 前即拒（绝不让未授权消息驱动 DSH）
    const acl = checkAllowed(cfg, aclMsgFromInbound(inbound))
    if (!acl.allowed) {
      gatedDebug(`acl:${inbound.chatKey}`, `deny|${acl.reason}`, `入站 ACL 拒绝：${inbound.chatKey}（${acl.reason}）`)
      return { handled: 'acl-denied', reason: acl.reason }
    }
    presence.noteIncoming(inbound.chatKey, String(inbound?.sender?.userId || ''), cfg)
    // 临时会话（SnowLuma 能力补齐）：ACL 放行的私聊若来自群临时会话，记住来源群，
    // 回复经 outbox 时带 group_id 才能送进临时会话。普通私聊不带、行为不变。
    if (String(inbound.chatKey || '').startsWith('private:') && ev?.sub_type === 'group') {
      const sg = String(ev?.sender?.group_id ?? '')
      if (/^\d+$/.test(sg) && Number(sg) > 0) outbox.notePrivateSource(inbound?.sender?.userId, sg)
    }
    // 旁路指令（审批批复 / 等待中的交互提问回答）：命中即消费，不进回合
    if (typeof interceptInteraction === 'function') {
      const text = textOfSegments(inbound.segments)
      const userId = String(inbound?.sender?.userId ?? '')
      try {
        if (interceptInteraction({ text, userId, chatId: inbound.chatKey })) {
          debug(`旁路指令消费：${inbound.chatKey}`)
          return { handled: 'interaction' }
        }
      } catch (error) { debug(`旁路指令判定出错（照常走回合）：${error.message}`) }
    }
    // 白名单内的媒体先暂存；总开关只阻止回合，不影响「刚才那张图」的后续读取。
    try { noteMedia?.(inbound.chatKey, inbound.segments, String(inbound?.sender?.userId || '')) } catch {}
    // 总开关 / 静音：入口拦（关了开关就不跑回合，不再只靠出站闸兜底）
    if (!cfg.enabled) {
      log.info(`总开关关着，收到 ${inbound.chatKey} 的消息但不处理：${textOfSegments(inbound.segments).slice(0, 30)}`)
      return { handled: 'disabled' }
    }
    if (typeof isMuted === 'function') {
      let muted = false
      try { muted = !!isMuted(inbound.chatKey) } catch {}
      if (muted) return { handled: 'muted' }
    }
    if (!rateAllowed(inbound)) {
      debug(`入站限流：${inbound.chatKey} 用户 ${String(inbound?.sender?.userId || '')} 消息未进入回合`)
      return { handled: 'ratelimited' }
    }
    const inGroup = inbound.chatKey.startsWith('group:')
    const text = textOfSegments(inbound.segments)
    const userId = String(inbound?.sender?.userId ?? '')
    // 群缓冲（legacy 同款：群里的每条消息都记，给上下文和「群里在不在聊」用；ACL 后、闸前）
    let mentioned = false
    let buffered = null
    if (inGroup) {
      try {
        mentioned = !!parseMessageEvent(ev, ev.self_id).mentioned
      } catch {}
      const self = String(ev.self_id || getConfig().botQQ || '')
      mentioned = mentioned || inbound.segments.some((s) => s?.type === 'at' && String(s.data?.qq || '') === self)
      const gid = inbound.chatKey.slice(6)
      buffered = groups.appendMessage(gid, { t: Date.now(), uid: userId, nick: String(inbound?.sender?.nickname || ''), text, self: userId === self, at: mentioned, mid: String(inbound.messageId || ''), direct: mentioned, replyId: replyIdOf(inbound), media: mediaOfInbound(inbound) })
      try { interaction.rememberSpeaker(inbound.chatKey, userId) } catch {}
    }
    const fromOwner = isOwner(cfg, userId)
    // 真机审计 1.11：入站面板统计
    try { onStats?.('received') } catch {}
    // 聊天流水（legacy hub.js 在 onMessage 里逐条记）：记忆整理/日记都从它取料
    try { logChat?.(inbound.chatKey, String(inbound?.sender?.nickname || ''), textOfSegments(inbound.segments), userId) } catch {}
    try {
      const count = collectInboundStickers?.(inbound.chatKey, inbound.segments, userId)
      if (typeof count === 'number') stickerPicks.set(inbound, count)
    } catch {}
    if (inGroup) {
      const offerWithDecision = (decision) => {
        emitActivity(mods, inbound, { direct: mentioned || decision.mode === 'must', owner: fromOwner })
        if (!decision.reply) {
          gatedDebug(`gate:${inbound.chatKey}`, decision.reason, `群闸 ${inbound.chatKey}：不回 —— ${decision.reason}`)
          return { handled: 'group-pass', reason: decision.reason }
        }
        try {
          const fg = normalizeFishGuard(cfg.group?.fishGuard || {})
          if (fg.enabled) {
            const now = Date.now()
            const gid = inbound.chatKey.slice(6)
            const pairKey = `${gid}:${userId}`
            // 鱼群保护需要「她↔对方」交替视角（缺陷：bot 自发不入缓冲 → pair/乒乓恒 0 空转）。
            // 缓冲只收入站消息；把她最近发言时间（speakTimes，noteSpeak 已记）合成 self 条目
            // 一并喂给 pair/密度判定。不写回缓冲，避免污染群提示词上下文。
            const botQQ = String(getConfig().botQQ || '')
            const selfMsgs = groups.speakTimes(gid, now).map((t) => ({ sender: '她', userId: botQQ, time: t, isSelf: true }))
            const fishMsgs = [...groups.buffer(gid).map((x) => ({ sender: x.nick, userId: x.uid, time: x.t, isSelf: x.self === true })), ...selfMsgs]
              .sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0))
            if (userId !== String(getConfig().ownerQQ || '')) {
              const calmUntil = pairCalmUntil.get(pairKey) || 0
              if (calmUntil > now) return { handled: 'group-pass', reason: '对聊冷却中' }
              const pairMsgs = dedupConvo(fishMsgs.filter((x) => x.userId && (x.isSelf === true || String(x.userId) === userId)))
              const loop = assessPairLoop(pairMsgs, userId, { guard: fg })
              if (loop.blocked) {
                pairCalmSweep(now)
                pairCalmUntil.set(pairKey, now + fg.pairCooldownMs)
                const reason = `与 ${inbound.sender?.nickname || userId} 已互来回 ${loop.rounds} 轮，进入对聊冷却`
                log.info(`群 ${gid}：${reason}`)
                return { handled: 'group-pass', reason }
              }
            }
            const direct = decision.mode === 'must'
            const density = assessFishDensity(fishMsgs, { now, guard: fg, groupId: gid })
            if (density.blocked) {
              const callerIsFish = senderFish({ userId, sender: inbound.sender?.nickname }, fg)
              if (!(direct && fg.bypassDirectAddress && !callerIsFish)) {
                const reason = fishGuardReasonText(density)
                log.info(`群 ${gid}：${reason}${direct && callerIsFish ? '，叫她的也在鱼名单里，豁免不适用' : ''}，本轮不参与`)
                return { handled: 'group-pass', reason }
              }
              debug(`群 ${gid}：${fishGuardReasonText(density)}，但被直接叫到 → 只回一句`)
            }
          }
        } catch (error) { debug(`鱼群保护判定出错：${error.message}`) }
        if (decision.mode) pendingMode.set(inbound.chatKey, decision.mode)
        const offered = controller.offer(inbound)
        // 正向决策也留痕：否则只能看到后一条“不回”，容易误判成它绕闸门发了上一条回合。
        debug(`群闸 ${inbound.chatKey}：回 —— ${decision.reason}｜消息 ${inbound.messageId || '?'}｜回合 ${offered.turnId}`)
        return { handled: 'offered', turnId: offered.turnId }
      }
      const applyHook = (decision) => {
        if (typeof moduleHooks?.groupDecide !== 'function') return offerWithDecision(decision)
        const msg = { ...parseMessageEvent(ev, ev.self_id), raw: ev }
        const policy = policyFor(cfg.group, cfg.group?.overrides, inbound.chatKey.slice(6))
        return Promise.resolve(moduleHooks.groupDecide(decision, {
          msg, policy, recentTexts: groups.buffer(inbound.chatKey.slice(6)).map((x) => x.text), memScore: 0,
        })).then((next) => offerWithDecision(next || decision))
      }
      const replyId = replyIdOf(inbound)
      if (replyId) {
        return quotedInfo(replyId, inbound.chatKey).then((quoted) => {
          const repliedToBot = Boolean(quoted?.ok && quoted.isBot)
          if (buffered) {
            if (repliedToBot) buffered.direct = true
            if (quoted) buffered.quoteNote = quoteNote(quoted)
          }
          return applyHook(decideGroupReplyFor({ chatKey: inbound.chatKey, text, mentioned, userId, repliedToBot }))
        })
      }
      return applyHook(decideGroupReplyFor({ chatKey: inbound.chatKey, text, mentioned, userId }))
    }
    emitActivity(mods, inbound, { direct: true, owner: fromOwner })
    const running = controller.runningTurnOf(inbound.chatKey)
    if (running && steeringChats.has(inbound.chatKey)) {
      controller.steer(running, inbound).catch((error) => {
        debug(`私聊插话失败，转为下一轮：${error?.message || error}`)
        controller.offer(inbound)
      })
      return { handled: 'steered', turnId: running }
    }
    const offered = controller.offer(inbound)
    return { handled: 'offered', turnId: offered.turnId }
  }

  function safeAdapt(ev, source) {
    try {
      const inbound = legacyEventToNormalized(ev, { selfId: ev.self_id, source })
      return { inbound, view: ev }
    } catch (error) {
      debug(`事件无法成键/不支持：${error.message}`)
      return { inbound: null, view: null }
    }
  }

  /** 补收入口（M4-4）：补收事件带原始时间，source=backfill（M1-B 语义同款）。与实时同一条主链（ACL/闸/静音/群闸）。 */
  function dispatchBackfill(ev, meta = {}) {
    const { inbound } = safeAdapt(ev, 'backfill')
    if (!inbound) return { handled: 'skipped' }
    backfillMeta.set(inbound, {
      gapMs: Number(meta.gapMs) || 120_000,
      earliestAgeMs: Number(meta.earliestAgeMs) || 0,
    })
    return routeInbound(inbound, ev, 'backfill')
  }

  /** 主动任务共用一个 QQ/DSH 会话，只生成文本，不在这里自动投递（调用方仍走统一 Outbox）。 */
  async function runPromptTurn(chatKey, text) {
    return controller.runExclusive(chatKey, async () => {
      if (timedOutChats.delete(chatKey)) resetChat(chatKey)
      // 与主链同款：上次 413 失败的标记在下次进入时归档重建（后台任务也走同一份会话映射）。
      if (oversizedChats.delete(chatKey)) resetChat(chatKey)
      const { sessionId } = await sessionForChat(chatKey)
      const ctrl = ctxGet('sessionController')
      const resolved = await ctrl?.resolveAgent?.(sessionId)
      const agent = resolved?.agent
      if (!agent?.followup) throw new Error('当前会话没有 agent.followup')
      let off = null
      const cleanup = () => { try { off?.() } catch {} off = null }
      const result = new Promise((resolve, reject) => {
        let lastTurn = null
        let lastText = ''
        off = dsh.on?.('session/event', (session, ev) => {
          if (session?.id !== sessionId) return
          if (ev?.type === 'tool/call' && /^(bili_watch|heybox_(feed|watch|hot)|douyin_(watch|recent|browse)|qq_draw_image)$/.test(String(ev?.data?.name || ''))) {
            reportTurns.set(chatKey, true)
            return
          }
          if (ev?.type === 'assistant/message') {
            const d = ev.data || {}
            if (d.interrupted) return
            const value = (d.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
            if (value) { lastTurn = d.turn; lastText = value }
          } else if (ev?.type === 'turn/end') {
            reportTurns.delete(chatKey)
            const d = ev.data || {}
            cleanup()
            if (d.reason?.kind !== 'completed') {
              // 与主链同款：413 / 请求体过大也要自愈（后台会话同样会攒图攒上下文）。
              // 主动任务没有人盯着看，notify=false：不往聊天里发提示（这轮本来就不投递）。
              if (turnFailureLooksOversized(d.reason?.error || d.reason?.failure || null)) handleOversizedTurn(chatKey, d.reason?.error || d.reason?.failure, { notify: false })
              reject(new Error(`主动回合未正常结束：${d.reason?.kind || '?'}`))
              return
            }
            resolve(lastTurn === d.turn ? String(lastText || '') : '')
          }
        })
        if (typeof off !== 'function') { cleanup(); reject(new Error('DSH 没有 session/event 流')) }
      })
      const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: String(text || '') }], source: { kind: 'qq-hub' } }
      const timeoutMs = Math.max(1, Number(getConfig().turnTimeoutMs) || 600_000)
      let timer = null
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`主动回合超过 ${Math.ceil(timeoutMs / 1000)} 秒未结束`)
          error.turnTimedOut = true
          reject(error)
        }, timeoutMs)
        timer.unref?.()
      })
      try {
        await Promise.race([agent.followup(message), timeout])
        return await Promise.race([result, timeout])
      } catch (error) {
        cleanup()
        if (error.turnTimedOut) handleTurnTimeout(chatKey, timeoutMs, { notify: false })
        throw error
      } finally {
        if (timer) clearTimeout(timer)
      }
    })
  }

  async function dispose() {
    // 线索挖掘链先收尾（S2 的模型调用可能还在飞），否则测试进程会带着未完成的 promise 退出。
    try { await threadObserver?.flush() } catch { /* 收尾失败不影响退出 */ }
    for (const mounted of mountedTools.values()) {
      for (const off of mounted.offs) { try { off?.() } catch {} }
    }
    mountedTools.clear()
    await systemTurns.dispose()
    await registry.dispose()
    await controller.dispose()
    outbox.dispose()
    try { groups.dispose?.() } catch { /* 群刹车状态收尾失败不影响退出 */ }
  }

  /** 重置当前 SessionRegistry 中的一个聊天；归档异步做，映射立即失效。 */
  function resetChat(chatKey) {
    const key = String(chatKey || '')
    recentTurns.delete(key) // 会话重置 = 关系线索的上下文也重新开始（不让旧对话影响新会话的信号判定）
    try { onResetChat?.(key) } catch {}
    const entry = registry.peek?.(key)
    if (!entry?.sessionId) return false
    try {
      const reg = ctxGet('workspaceRegistry')
      Promise.resolve(reg?.archiveSession?.(entry.sessionId)).catch(() => {})
    } catch { /* 归档失败不影响重置 */ }
    cleanupSession(entry.sessionId)
    participants.clear(entry.sessionId)
    sessionPersonas.delete(key)
    try { registry.forget?.(key) } catch { /* ignore */ }
    debug(`会话已重置（新核心）：${key}`)
    return true
  }

  /**
   * 人设配置变更后，按「新旧预期人设」逐聊天比对，重置真正变了的那批会话。
   *
   * 为什么不让面板自己比：面板只有 `entry.personaId`（建会话时记下的），而
   *   - 各路由拿到的 sessions 视图经过不同包装，字段和时机都对不上；
   *   - 更关键的是 `personaId` 只记录「建会话那一刻」，之后 groupDefault /
   *     privateDefault 改了它不会动。用「旧记录 vs 新配置」去比，必然漏判
   *     （2026-11-15 真机：群聊默认锁在豆包卡，点「设为当前」切成小鲸鱼，
   *      群会话人设其实没变、也确实不该重置，但私聊被 privateDefault 同样锁住
   *      时用户看到的就是「切卡完全没反应」）。
   * 这里统一以**配置**为准算两边预期：oldConfig 的预期 vs 现状，换卡即有 diff。
   *
   * @param {object} oldConfig 变更前的配置（必须是人设变更前的快照）
   * @returns {{chatId:string, from:string, to:string}[]} 被重置的会话清单
   */
  function resetChatsForPersonaChange(oldConfig) {
    const nextCfg = getConfig()
    const changed = []
    let snap = {}
    try { snap = registry.snapshot() || {} } catch { return changed }
    for (const [chatKey, entry] of Object.entries(snap)) {
      if (!entry?.sessionId) continue
      let want = ''
      let had = ''
      try {
        want = personaIdFor(chatViewFor(chatKey), nextCfg)
        had = personaIdFor(chatViewFor(chatKey), oldConfig)
      } catch { continue }
      // 预期没变 = 这张卡对这条聊天没影响，历史里也没有别的卡，不用动它
      if (want === had) continue
      // 会话里固化的正是旧卡才需要重置；若已经是新卡（上一轮刚重建过）就跳过
      const recorded = sessionPersonas.get(chatKey)?.personaId || ''
      if (recorded === want) continue
      if (resetChat(chatKey)) changed.push({ chatId: chatKey, from: recorded || had || '', to: want || '' })
    }
    return changed
  }

  function knownChats() {
    return Object.entries(registry.snapshot()).map(([chatId, entry]) => {
      const kind = chatId.startsWith('group:') ? 'group' : 'private'
      const id = chatId.slice(kind.length + 1)
      // rawName：不带「QQ 群 · 」前缀的纯群名（查不到为空串）。审计 Q13：前端为了
      // 拿群名一直在请求一个已删除的 /groups/titles 路由（失败静默、永远退回群号）；
      // 现在统一走 /panel/chats，从这里取。
      const rawName = kind === 'group' ? String(groupNames.get(id) || '') : ''
      return { chatId, kind, id, name: kind === 'group' ? `QQ 群 · ${groupNames.get(id) || id}` : chatId, rawName, lastAt: Number(entry.lastTurnAt || entry.createdAt || 0) }
    }).sort((a, b) => b.lastAt - a.lastAt)
  }

  /** 当前 SessionRegistry 的会话 id → chatKey 反查，供审批、提问和模块工具使用。 */
  function chatKeyOfSession(sessionId) {
    const sid = String(sessionId || '')
    if (!sid) return ''
    const hit = activeChatBySessionId.get(sid)
    if (hit) return hit
    const snap = registry.snapshot?.() || {}
    for (const [chatKey, entry] of Object.entries(snap)) {
      if (entry && String(entry.sessionId) === sid) return chatKey
    }
    // 兼容带/不带 session- 前缀两种写法
    const bare = sid.startsWith('session-') ? sid.slice(8) : sid
    for (const [chatKey, entry] of Object.entries(snap)) {
      const v = String(entry?.sessionId || '')
      if (v === sid || v.endsWith(bare)) return chatKey
    }
    return ''
  }

  async function syncAllModels() {
    let applied = 0
    let skipped = 0
    let failed = 0
    let dropped = 0
    const detail = []
    for (const [chatId, entry] of Object.entries(registry.snapshot())) {
      const sessionId = String(entry?.sessionId || '')
      if (!sessionId) { skipped++; continue }
      let want = ''
      try {
        const target = await resolveTarget(chatViewFor(chatId))
        want = modelKey(target)
        if (!want || selectedModels.get(sessionId) === want) { skipped++; continue }
        const ctrl = ctxGet('sessionController')
        if (!ctrl?.resolveAgent) throw new Error('DSH 没有 sessionController.resolveAgent')
        const resolved = await ctrl.resolveAgent(sessionId)
        if (!resolved?.agent) throw new Error(resolved?.error?.message || resolved?.error?.code || 'no session')
        if (registry.peek(chatId)?.sessionId !== sessionId) { skipped++; continue }
        if (!await applySessionModel(resolved.agent, sessionId, target)) throw new Error('会话模型选择不可用')
        applied++
        detail.push({ chatId, want, ok: true })
      } catch (error) {
        failed++
        const item = { chatId, ...(want ? { want } : {}), ok: false, error: String(error?.message || error) }
        if (/not[ -]found|不存在|已归档|no session/i.test(item.error) && registry.peek(chatId)?.sessionId === sessionId) {
          cleanupSession(sessionId)
          sessionPersonas.delete(chatId)
          registry.forget(chatId)
          item.dropped = true
          dropped++
        }
        detail.push(item)
      }
    }
    return { applied, skipped, failed, dropped, detail }
  }

  const services = {
    deliver: (chatId, text, opts) => replyDelivery.deliver(chatId, text, opts),
    // 道别后的主动开口静默期（conversation-closure 的 CLOSED + muteLockMs）。
    // 只锁主动搭话，不锁入站回复 —— speakup / purpose 据此少打扰一次。
    proactiveMuteState: (chatId, now) => replyDelivery.proactiveMuteState(chatId, now),
    isProactivelyMuted: (chatId, now) => replyDelivery.isProactivelyMuted(chatId, now),
    ...outbound,
    ...outboundFiles,
    pushToSession: (chat, content) => runPromptTurn(chat.chatId, (content || []).map((block) => block.text || '').join('\n')),
    onSessionEvent: participants.onSessionEvent,
    noteTurnSenders: participants.note,
    turnHasOwner: participants.turnHasOwner,
    turnSendersAllOwner: participants.turnSendersAllOwner,
    turnHasUniqueImageGenOwnerRequester: participants.turnHasUniqueImageGenOwnerRequester,
    lastTextOf: participants.lastTextOf,
    prevTextOf: participants.prevTextOf,
    speakersOf: participants.speakersOf,
    simulateTurn: participants.simulateTurn,
    capture: capture.capture,
    captureOnly: capture.captureOnly,
    faceName: faces.nameOf,
    wasSent: (messageId) => sentIds.has(String(messageId || '')),
    currentTicket: () => deliveryContext.getStore()?.ticket || null,
    groupName: groupNameOf,
    groupNames,
    joinTopic: (gid) => groups.joinTopic(gid),
    leaveTopic: (gid) => groups.leaveTopic(gid),
    isBusy: (chatId) => Boolean(controller.runningTurnOf(chatId) || controller.mergingTurnOf(chatId) || activity.isBusy(chatId)),
    canSeeImages: async (chat) => {
      const cfg = getConfig()
      if (cfg.model?.vision === 'on') return true
      if (cfg.model?.vision === 'off') return false
      const selected = await resolveTarget(chat)
      return selected ? modelVision(dsh, selected.provider, selected.model) : null
    },
    modelFor: selectModel,
    resolveTarget,
    stats: presence.stats,
    lastChatAt: () => presence.lastChatAt,
    lastOwnerChatAt: () => presence.lastOwnerChatAt,
    lastBotToOwner: () => presence.lastBotToOwner,
    selfId: () => selfId,
    // US-019 测试/排障出口：线索生产者（S1+S2）的观察器。没有账本时为 null。
    threadObserver: threadObserver || null,
    /** 等未完成的线索挖掘收尾（S2 是 fire-and-forget，测试不能靠 sleep 猜）。 */
    flushThreads: () => (threadObserver ? threadObserver.flush() : Promise.resolve()),
  }

  return {
    services,
    // 测试出口：装配主链本身。wiring 测试必须走**这里**而不是自己 new 一个
    // createContextAssembly({providers:[...]})——后者绕过了 `threadLedger ? [...threadProviders] : []`
    // 这个真实注册点，导致「摘掉 threadProviders 注册」的变异全绿（US-010 第二轮验收实测漏检）。
    assemblyForTest: assembly,
    dispatchLegacyEvent,
    dispatchLegacyEventSettled,
    runPromptTurn,
    runSystemTurn: (name, title, prompt, opts) => systemTurns.run(name, title, prompt, opts),
    syncAllModels,
    sessions,
    knownChats,
    resetSessions: () => systemTurns.resetSessions(),
    markTurnAt: (chatKey, now) => registry.markTurn(chatKey, now),
    chatKeyOfSession,
    resetChat,
    resetChatsForPersonaChange,
    dispatchBackfill,
    outbox,
    registry,
    controller,
    dispose,
    // 测试出口：入站文件补水后的 segments 是否已中和，必须能**绕过**下游
    // segmentsToContent / groupPromptContent 单独验证。否则这一层永远被下游挡住，
    // 摘掉它测试照样全绿——「深度防御」不该变成「测不出来的防御」。
    hydrateInboundFilesForTest: hydrateInboundFiles,
    stats: () => ({
      sessions: Object.keys(registry.snapshot()).length,
      cacheEntries: ctxBoxes.size + ctxBound.size + personaBound.size + ctxFallback.size + ctxFallbackDone.size + mountedTools.size,
    }),
  }
}
