// M4 · 模块化新核心组装根（FLAG_MODULAR_CORE 开启态；关闭态本工厂不被装配）
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
import { createSessionRegistry } from '../chat/session-registry.js'
import { createSessionFileStore } from '../chat/session-store.js'
import { createSystemTurns } from '../chat/system-turns.js'
import { createTurnController } from '../chat/turn-controller.js'
import { createContextAssembly } from '../chat/context-assembly.js'
import { createOutbox } from '../chat/outbox.js'
import { createReplyDelivery } from '../chat/reply-delivery.js'
import { createInteractionState } from '../chat/interaction-state.js'
import { createOutbound } from '../chat/outbound.js'
import { createDeliveryLedger } from '../chat/delivery-ledger.js'
import { isOwner, checkAllowed, levelFor, presetFor } from '../chat/access.js'
import { createActivityState } from '../chat/activity-state.js'
import { checkIdentityLeak } from '../chat/identity-guard.js'
import { parseMessageEvent, cardText } from '../chat/inbound.js'
import { parseCommand } from '../chat/commands.js'
import { createInboundImages } from '../chat/inbound-images.js'
import { createInboundVision } from '../chat/inbound-vision.js'
import { parseReply, replyRules, wantsVoice } from '../chat/reply.js'
import { defaultModel, pickReasoningEffort } from '../core/llm.js'
import { resolveChatModel } from '../chat/chat-model.js'
import { personaIdFor } from '../persona/personas.js'
import { workspaceDirOf, workspaceDirForChat, WORKSPACE_TITLE } from '../chat/workspace.js'
import { createGroupState } from '../chat/group-state.js'
import { policyFor, decideGroupReply, topicRelevance } from '../chat/group-policy.js'
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
 *  蒸馏/心情/token-guardian 等模块的 activity 计数全挂在这个事件上；开旗后消息不走 hub，
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

/** 入站成员段 → DSH content 块（legacy 视图语义：文本段原样、图片段带 url/file、其余如实降级）。 */
function segmentsToContent(members) {
  const content = []
  for (const m of members) {
    for (const s of (m?.segments ?? [])) {
      if (s?.type === 'text') { const t = String(s.data?.text ?? ''); if (t) content.push({ type: 'text', text: t }) }
      else if (s?.type === 'image' || s?.type === 'mface') content.push({ type: 'image', url: String(s.data?.url || s.data?.file || '') })
      else if (s?.type === 'reply' || s?.type === 'at') continue
      else if (s?.type === 'forward') content.push({ type: 'text', text: '\n[合并转发（内容没拉到）]\n' })
      else if (s?.type === 'json') content.push({ type: 'text', text: `\n${cardText(s.data?.data)}\n` })
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
 * @param {() => object|null} [o.moodEffects] 心情效果注入（群插话概率调制；同 hub 的 mood().chatty 乘法，缺省 1）
 * @param {(text: string, chat: object) => number} [o.memoryScore] 话题相关度（同 hub memoryScore，缺省 0）
 * @param {(chatId: string) => boolean} [o.isMuted] 静音判定（真机审计 1.10：入口就要拦，关了嘴不等于停脑）
 * @param {(msg: {text: string, userId: string, chatId: string}) => boolean} [o.interceptInteraction]
 *   旁路指令桥接（真机审计 1.9：主人「通过 #1」批复审批 / 等待中的交互提问回答优先消费；命中即不进回合）
 * @param {(chat: object) => string|null} [o.personaTextFor] 按聊天人设（真机审计 1.2：persona.privates/groups
 *   专用卡 + 蒸馏语感卡按群生效；返回 null = 跟随全局人设）
 * @param {(chatId: string, who: string, text: string, uid?: string) => void} [o.logChat]
 *   聊天流水（真机审计：新核心不写 chatlog → 记忆整理/蒸馏/黑话/日记四条链无料；实测当天进站 5900、流水 12 行）
 * @param {(sessionId: string, senders: string[], opts?: object) => void} [o.noteSpeakers]
 *   回合说话人登记（hub.turnState 数据源；memory.contextFor 取「正在说话的几个人」靠它）
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
  personaText, runCommand, ledgerFile, sessionStoreFile,
  moodEffects, memoryScore, isMuted, interceptInteraction, personaTextFor, onStats, noteMedia, promptVars, stickers, tts, buildTools, toolsGeneration, localApi, logChat, noteSpeakers, onResetChat, collectInboundStickers, availableModels, moduleHooks, markTurnAt, sharedOutbox, isSentMessage, inboundAudio, quotedMessages: sharedQuotedMessages, inboundImages: sharedInboundImages, inboundVision: sharedInboundVision,
}) {
  const audio = inboundAudio || createInboundAudio({ onebot, dsh, localApi, log })
  const quotedMessages = sharedQuotedMessages || createQuotedMessages({ onebot, getConfig, isSentMessage, log })
  const inboundImages = sharedInboundImages || createInboundImages({ onebot, dsh, log })
  const inboundVision = sharedInboundVision || createInboundVision({ dsh, log, inboundImages })
  const debug = (m) => { try { log?.debug?.(m) } catch {} }
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
  const groups = createGroupState()
  const interaction = createInteractionState()
  const reportTurns = new Map()
  const pendingMode = new Map() // chatKey → 决定本轮的 mode（interject/engaged/must），execute 消费
  const steeringChats = new Set() // 只在 DSH 生成期接受 steer；出站期的新消息排下一轮
  const timedOutChats = new Set() // 超时时保留映射；下一条消息到来再归档重建
  const backfillMeta = new WeakMap() // inbound → 网关实测断线时长/最早消息年龄
  const stickerPicks = new WeakMap()
  const stickerHint = (n) => `（这轮里夹着 ${n} 张表情，是你自己看到的。有中意的就用 qq_collect_sticker ${n > 1 ? `1~${n}` : '1'} 收进自己库；收表情是你自己的小爱好，不用每张都跟对方说，偶尔提一句也行。）`
  const moodChatty = () => {
    try {
      const m = typeof moodEffects === 'function' ? moodEffects() : null
      return m && typeof m.chatty === 'number' ? m.chatty : 1
    } catch { return 1 }
  }
  /** 群消息要不要回：与 legacy 同一 decideGroupReply 调用形状。 */
  function decideGroupReplyFor({ chatKey, text, mentioned, userId, repliedToBot = false }) {
    const cfg = getConfig()
    const now = Date.now()
    const gid = chatKey.slice(6)
    const pol0 = policyFor(cfg.group, cfg.group?.overrides, gid)
    const pol = { ...pol0, interjectChance: Math.min(1, pol0.interjectChance * moodChatty()) }
    const recentTexts = groups.buffer(gid).filter((x) => now - x.t < pol.activeWindowSec * 1000).slice(-6).map((x) => x.text)
    let memScore = 0
    try {
      const memChat = { chatId: chatKey, kind: 'group', groupId: gid }
      memScore = typeof memoryScore === 'function' ? memoryScore(recentTexts.join(' '), memChat) : 0
    } catch { memScore = 0 }
    return decideGroupReply({
      policy: pol,
      relevance: topicRelevance(recentTexts, pol.interests, memScore),
      engagedUntil: groups.engagedUntil(gid),
      mentioned: !!mentioned,
      repliedToBot: !!repliedToBot,
      fromOwner: isOwner(cfg, userId),
      text,
      now,
      hour: new Date().getHours(),
      recentTimes: groups.buffer(gid).map((x) => x.t),
      interjectTimes: groups.interjectTimes(gid),
      botReplyTimes: groups.speakTimes(gid),
    })
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
  async function resolveTarget(chat) {
    const cfg = getConfig()
    const base = defaultModel(dsh, cfg)
    let sel = base ? { provider: base.provider, model: base.model, reasoningEffort: cfg.model?.reasoningEffort || '' } : null
    const specific = resolveChatModel(cfg, chat, typeof availableModels === 'function' ? availableModels() : null)
    if (specific) sel = { provider: specific.provider, model: specific.model, reasoningEffort: specific.reasoningEffort || cfg.model?.reasoningEffort || '' }
    if (typeof moduleHooks?.model === 'function') sel = moduleHooks.model(sel, chat) ?? sel
    if (!sel?.provider || !sel?.model) return null
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

  const admitContent = (content, context) => inboundVision.admit(content, context)

  const replyIdOf = (member) => String((member?.segments || []).find((s) => s?.type === 'reply')?.data?.id ?? '')
  const quotedInfo = (replyId, chatKey) => quotedMessages.get(replyId, chatKey)

  function quoteNote(q) {
    if (!q?.ok) return '（引用了某条消息，但内容没读到；如果影响理解，可以如实说没看到，让对方重发或说一下是哪条）'
    const owner = String(getConfig().ownerQQ || '')
    const who = q.isBot ? '你' : owner && q.uid === owner ? '主人' : `${q.who || q.uid || '某人'}${q.uid ? `(${q.uid})` : ''}`
    const body = String(q.text || '').replace(/\[(图片|表情包)\]/g, '').trim() || (q.media.length ? '（图片/表情）' : '（没有文字）')
    return `（引用 ${who} 的消息：「${body}」${q.media.length ? `，另有 ${q.media.length} 张图片/表情包` : ''}）`
  }

  async function hydrateQuotes(members, chatKey) {
    const out = []
    for (const member of Array.isArray(members) ? members : []) {
      const replyId = replyIdOf(member)
      if (!replyId) { out.push(member); continue }
      const quoted = await quotedInfo(replyId, chatKey)
      out.push({
        ...member,
        segments: [...(member.segments || []), { type: 'text', data: { text: `\n${quoteNote(quoted)}` } }, ...quoted.media],
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
  async function sessionForChat(chatKey) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await registry.sessionFor(chatKey)
      if (registry.peek(chatKey)?.sessionId !== entry.sessionId) continue
      let persona = sessionPersonas.get(chatKey)
      if (!persona || persona.sessionId !== entry.sessionId) {
        persona = { sessionId: entry.sessionId, personaId: currentPersona(chatKey) }
        sessionPersonas.set(chatKey, persona)
      }
      if (persona.personaId === currentPersona(chatKey)) return entry
      resetChat(chatKey)
    }
    throw new Error(`人设变化过快，无法创建稳定会话：${chatKey}`)
  }

  // ---------- Context Assembly（模块上下文 + 人格） ----------
  const assembly = createContextAssembly({
    providers: [
      ...(personaText ? [{ moduleId: 'persona', priority: 1000, scope: 'global', cacheStable: true, provide: () => personaText() || '' }] : []),
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
  const outbound = createOutbound({
    getConfig, log, onebot, outbox, groups, stickers, tts, interaction,
    hooks: moduleHooks, onStats, deliveryContext,
  })
  const replyDelivery = createReplyDelivery({
    deliveryContext,
    getConfig, log, hooks: moduleHooks, reportTurns, groups, stickers,
    mood: () => (typeof moodEffects === 'function' ? moodEffects() : null) || { sticker: 1, voice: 1, delay: 1, chatty: 1 },
    interaction,
    ...outbound,
    logChat,
    onActivity: (event) => mods.emit?.('activity', event),
    outbox: () => outbox,
  })

  // ---------- Turn Controller（执行 = 会话轮次 + 装配 + 投递） ----------
  /** 群聊上下文拼接（真机审计 1.3；legacy groupPrompt 的简化复刻）：
   *  未投喂最近 20 条 + 已投喂 8 条，带发言人标记与相对时间；主人只标「主人」不落号码。
   *  引用正文由 quotedInfo 水合；<reply:n>/<at:> 与富媒体出站统一经当前 reply-delivery。 */
  function groupPromptContent(chatKey, members, previousTurnAt) {
    const gid = chatKey.slice(6)
    const buf = groups.buffer(gid)
    const fresh = buf.filter((x) => !x.fed).slice(-20)
    const older = buf.filter((x) => x.fed).slice(-8)
    for (const x of buf) x.fed = true
    const mode = pendingMode.get(chatKey) || 'must'
    pendingMode.delete(chatKey)
    const nowAt = Date.now()
    const ownerQQ = String(getConfig().ownerQQ || '')
    const whoOf = (x) => (ownerQQ && String(x.uid) === ownerQQ ? '主人' : `${x.nick || x.uid}(${x.uid})`)
    const line = (x) => `${whoOf(x)}${x.at ? '@了你' : ''}${agoLabel(x.t, nowAt)}：${x.text || '（图片/表情）'}`
    const name = groupNames.get(gid) || gid
    const hint = mode === 'interject' ? '（没人叫你。只有你对这个话题真有话说、能自然接上时才插一句：接着话题说，别突然开新话题；接不上就只回 [沉默]）'
      : mode === 'engaged' ? '（你刚才在参与这个话题。想接着聊就接着说，话题和你没关系了或没什么可说的就只回 [沉默]）'
      : '（有人在叫你，看完这一段再回）'
    const refs = {}
    const numbered = fresh.map((x, i) => {
      if (x.mid && x.mid !== '0') refs[i + 1] = { mid: x.mid, uid: x.uid }
      return `[${i + 1}] ${line(x)}`
    })
    groups.setRefs(gid, refs)
    const timeHead = nowLine(nowAt, previousTurnAt, { what: '上一段消息' })
    const head = (older.length ? `【群聊 ${name}】之前在聊：\n${older.map(line).join('\n')}\n\n` : '') +
      `【群聊 ${name}】刚才新说的（${fresh.length} 条）${hint}\n${timeHead}\n${numbered.join('\n')}\n\n` +
      '把这一段当成整体来回：一般说一两句就好，回给最需要回的那个人或者整个话题，不要一条一条地挨个回。\n' +
      '大多数时候直接说就行。只有想专门接其中某一条时才在那句话开头写 <reply:编号>，会以「引用回复」发出；一次最多引用一条。\n' +
      '要 @ 某个人（对方会收到提醒），写 <at:QQ号>，QQ 号就是上面名字后面括号里的数字。'
    // 触发轮自身的图片与引用说明一并附上；reply 段已由 quoteNote 取代，不留下占位。
    // 没触发回合的那几条群消息带的图也在这里补：群缓冲里挂着 image 块，否则她只看得到
    // 「（图片/表情）」文字，而触发轮 members 已经没有原始段可拼（真机：群里看不懂表情包）。
    const extras = []
    const quotes = []
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
      else if (s?.type === 'text' && s.data?.inboundFile) extras.push({ type: 'text', text: String(s.data.text || '') })
      else if (s?.type === 'text' && String(s.data?.text || '').includes('（引用 ')) quotes.push(String(s.data.text))
      else if (s?.type === 'json') extras.push({ type: 'text', text: cardText(s.data?.data) })
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
    if (quotes.length) extras.unshift({ type: 'text', text: quotes.join('\n') })
    const direct = fresh.filter((x) => x.direct)
    const directSenders = new Set(direct.map((x) => x.uid))
    const target = directSenders.size === 1 ? direct.at(-1) : null
    const autoReply = target ? { mid: target.mid, uid: target.uid } : null
    const query = fresh.map((x) => x.text).filter(Boolean).join('\n')
    const speakers = [...new Set(fresh.map((x) => String(x.uid)).filter(Boolean))]
    return { blocks: [{ type: 'text', text: head }, ...extras], mode, autoReply, query, speakers }
  }
  // 上下文/人设挂载：agent 级一次性注册（legacy mount 同型），text 闭包每轮读最新
  // 键必须是**会话 id**：resolveAgent 每轮返回新的 agent 包装对象，用对象做键永远不命中
  const ctxBoxes = new Map() // sessionId -> { text }
  const ctxBound = new Set() // 已注册过 context 的 sessionId
  const personaBound = new Set() // 已注册过 persona 变量的 sessionId
  const ctxFallback = new Set() // 宿主已占用同名 context：退回「把背景拼进消息」
  const ctxFallbackDone = new Set() // 已经投过一次的会话（避免每轮重复注入）

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
    selectedModels.delete(sid)
    slowNoticeSent.delete(sid)
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
          ...inboundFileBlocks(files, member.sender?.nickname || memberChat.userId).map((block) => ({ type: 'text', data: { text: block.text, inboundFile: true } })),
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
      const chat = chatViewFor(turn.chatKey, io.members)
      const inGroup = chat.kind === 'group'
      const { sessionId } = await sessionForChat(turn.chatKey)
      // 装配上下文时使用当前会话，避免重建人设后仍传入旧 sessionId。
      const { fragments } = await assembly.assemble({ chatKey: turn.chatKey, sessionId, chat })
      const queryText = textOfSegments(io.members.flatMap((m) => m.segments || []))
      // 回合说话人登记（speakersOf 的数据源；群聊记忆检索要用）
      try { noteSpeakers?.(String(sessionId), (io.members || []).map((m) => String(m?.sender?.userId || '')).filter(Boolean), { chatId: turn.chatKey, queryText }) } catch {}
      // 3. 构造会话消息：群聊带整段缓冲上下文（真机审计 1.3），私聊用触发段本体
      let turnMode = null
      let autoReply = null
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
      const previousTurnAt = turnAt(turn.chatKey)
      if (inGroup) {
        const gp = groupPromptContent(turn.chatKey, members, previousTurnAt)
        content = gp.blocks
        turnMode = gp.mode
        autoReply = gp.autoReply
        try { noteSpeakers?.(String(sessionId), gp.speakers, { chatId: turn.chatKey, queryText: gp.query }) } catch {}
      } else {
        content = segmentsToContent(members)
        const source = `【私聊】${chat.nickname || chat.userId}(${chat.userId})：`
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
          const source = `【私聊】${inbound.sender?.nickname || inbound.sender?.userId}(${inbound.sender?.userId})：`
          const timeHead = nowLine(Date.now(), previousTurnAt)
          const index = steerContent.findIndex((block) => block.type === 'text')
          if (index >= 0) steerContent[index] = { ...steerContent[index], text: `${source}\n${timeHead}\n${steerContent[index].text || ''}` }
          else steerContent.unshift({ type: 'text', text: `${source}\n${timeHead}\n` })
          const stickerPick = stickerPicks.get(inbound)
          if (stickerPick) steerContent.push({ type: 'text', text: stickerHint(stickerPick) })
          const steerQuery = textOfSegments(inbound.segments)
          try { noteSpeakers?.(String(sessionId), [String(inbound.sender?.userId || '')].filter(Boolean), { chatId: turn.chatKey, queryText: steerQuery }) } catch {}
          if (typeof moduleHooks?.prompt === 'function') {
            const next = await moduleHooks.prompt(steerContent, { chat, sessionId, senderId: chat.userId, prevText: '', queryText: steerQuery, steer: true })
            if (next == null) return
            steerContent = next
          }
          const admittedSteer = await admitContent(steerContent, {
            nickname: inbound.sender?.nickname || inbound.sender?.userId,
            hint: textOfSegments(inbound.segments), cfg: getConfig(),
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
          if (!completion.completed) { reject(new Error(`回合未正常结束：${completion.kind || '?'}`)); return }
          resolve(completion.text)
        }
        off = dsh.on?.('session/event', (session, ev) => {
          if (session?.id !== sessionId) return
          if (ev?.type === 'tool/call' && /^(rss_read|bili_watch|heybox_(feed|watch|hot)|douyin_(watch|recent|browse)|qq_draw_image|qq_song_cover)$/.test(String(ev?.data?.name || ''))) {
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
            completion = { completed: d.reason?.kind === 'completed', kind: d.reason?.kind, text: lastTurn === d.turn ? String(lastText || '') : '' }
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
        hint: textOfSegments(io.members.flatMap((member) => member.segments || [])), cfg: getConfig(),
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
        await replyDelivery.deliver(turn.chatKey, reply, {
          own: true,
          userText: textOfSegments(io.members.flatMap((m) => m.segments || [])),
          wantVoice: wantsVoice(textOfSegments(io.members.flatMap((m) => m.segments || []))),
          autoReply,
          refs: inGroup ? groups.refs(chat.groupId) : {},
        })
        if (inGroup) {
          try { if (turnMode === 'interject') groups.noteInterject(chat.groupId) } catch {}
        }
        return { state: 'sent', via: 'reply-delivery' }
      } catch (error) {
        log.warn(`回复发送失败：${error?.message || error}`)
        throw error
      }
    },
  })

  /** 聊天域消息入口（host dispatchEvent 的旗开分支）。 */
  async function dispatchLegacyEvent(ev) {
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
   *  activity 在闸之前发：蒸馏等模块的计数不受「要不要回」影响。）
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
      debug(`入站 ACL 拒绝：${inbound.chatKey}（${acl.reason}）`)
      return { handled: 'acl-denied', reason: acl.reason }
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
      buffered = groups.appendMessage(gid, { t: Date.now(), uid: userId, nick: String(inbound?.sender?.nickname || ''), text, at: mentioned, mid: String(inbound.messageId || ''), direct: mentioned, replyId: replyIdOf(inbound), media: mediaOfInbound(inbound) })
      try { interaction.rememberSpeaker(inbound.chatKey, userId) } catch {}
    }
    const fromOwner = isOwner(cfg, userId)
    // 真机审计 1.11：入站面板统计
    try { onStats?.('received') } catch {}
    // 聊天流水（legacy hub.js 在 onMessage 里逐条记）：记忆整理/蒸馏/黑话/日记都从它取料
    try { logChat?.(inbound.chatKey, String(inbound?.sender?.nickname || ''), textOfSegments(inbound.segments), userId) } catch {}
    try {
      const count = collectInboundStickers?.(inbound.chatKey, inbound.segments, userId)
      if (typeof count === 'number') stickerPicks.set(inbound, count)
    } catch {}
    if (inGroup) {
      const offerWithDecision = (decision) => {
        emitActivity(mods, inbound, { direct: mentioned || decision.mode === 'must', owner: fromOwner })
        if (!decision.reply) {
          debug(`群闸 ${inbound.chatKey}：不回 —— ${decision.reason}`)
          return { handled: 'group-pass', reason: decision.reason }
        }
        if (decision.mode) pendingMode.set(inbound.chatKey, decision.mode)
        const offered = controller.offer(inbound)
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
          if (buffered && repliedToBot) buffered.direct = true
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
          if (ev?.type === 'tool/call' && /^(rss_read|bili_watch|heybox_(feed|watch|hot)|douyin_(watch|recent|browse)|qq_draw_image|qq_song_cover)$/.test(String(ev?.data?.name || ''))) {
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
            if (d.reason?.kind !== 'completed') { reject(new Error(`主动回合未正常结束：${d.reason?.kind || '?'}`)); return }
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
    for (const mounted of mountedTools.values()) {
      for (const off of mounted.offs) { try { off?.() } catch {} }
    }
    mountedTools.clear()
    await systemTurns.dispose()
    await registry.dispose()
    await controller.dispose()
    outbox.dispose()
  }

  /** 重置当前 SessionRegistry 中的一个聊天；归档异步做，映射立即失效。 */
  function resetChat(chatKey) {
    const key = String(chatKey || '')
    try { onResetChat?.(key) } catch {}
    const entry = registry.peek?.(key)
    if (!entry?.sessionId) return false
    try {
      const reg = ctxGet('workspaceRegistry')
      Promise.resolve(reg?.archiveSession?.(entry.sessionId)).catch(() => {})
    } catch { /* 归档失败不影响重置 */ }
    cleanupSession(entry.sessionId)
    sessionPersonas.delete(key)
    try { registry.forget?.(key) } catch { /* ignore */ }
    debug(`会话已重置（新核心）：${key}`)
    return true
  }

  function knownChats() {
    return Object.entries(registry.snapshot()).map(([chatId, entry]) => {
      const kind = chatId.startsWith('group:') ? 'group' : 'private'
      const id = chatId.slice(kind.length + 1)
      return { chatId, kind, id, name: kind === 'group' ? `QQ 群 · ${groupNames.get(id) || id}` : chatId, lastAt: Number(entry.lastTurnAt || entry.createdAt || 0) }
    }).sort((a, b) => b.lastAt - a.lastAt)
  }

  /** 当前 SessionRegistry 的会话 id → chatKey 反查，供审批、提问和模块工具使用。 */
  function chatKeyOfSession(sessionId) {
    const sid = String(sessionId || '')
    if (!sid) return ''
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

  return {
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
    dispatchBackfill,
    outbox,
    registry,
    controller,
    dispose,
    stats: () => ({
      sessions: Object.keys(registry.snapshot()).length,
      cacheEntries: ctxBoxes.size + ctxBound.size + personaBound.size + ctxFallback.size + ctxFallbackDone.size + mountedTools.size,
    }),
  }
}
