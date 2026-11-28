// 当前唯一生产核心组装根（薄装配 + 接线）。
//
// 结构：入站纯函数在 core/inbound-prep.js、群闸在 core/group-gate.js、回合失败在
// core/turn-failure.js、会话生命周期在 core/session-lifecycle.js；这里只做依赖注入与接线。
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

import { createDshSessionAdapter } from '../chat/adapters/dsh-session.js'
import { createOnebotOutboxAdapter } from '../chat/adapters/onebot-outbox.js'
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
import { createOutboundFiles } from '../chat/outbound-files.js'
import { createTurnParticipants } from '../chat/turn-participants.js'
import { createTurnRunner } from '../chat/dsh-turn-runner.js'
import { createTurnStickers } from '../chat/turn-stickers.js'
import { createPresence } from '../chat/presence.js'
import { createCapture } from '../chat/capture.js'
import { createFaces } from '../chat/faces.js'
import { createDeliveryLedger } from '../chat/delivery-ledger.js'
import { checkAllowed, levelFor, presetFor } from '../chat/access.js'
import { createActivityState } from '../chat/activity-state.js'
import { checkIdentityLeak } from '../chat/identity-guard.js'
import { neutralizeInboundDsl } from '../chat/inbound.js'
import { createInboundImages } from '../chat/inbound-images.js'
import { createInboundVision } from '../chat/inbound-vision.js'
import { wantsVoice } from '../chat/reply.js'
import { defaultModel, pickReasoningEffort, modelVision } from '../core/llm.js'
import { redact } from '../core/redact.js'
import { resolveChatModel } from '../chat/chat-model.js'
import { personaIdFor, personaHash } from '../persona/personas.js'
import { workspaceDirForChat, WORKSPACE_TITLE } from '../chat/workspace.js'
import { createGroupState } from '../chat/group-state.js'
import { readJson, writeJson } from '../core/store.js'
import { createRepeatGate } from '../core/repeat-gate.js'
import { gateFromEnv } from '../chat/group-atmosphere-gate.js'

import { nowLine } from '../chat/clockline.js'
import { backfillNoticeBlock } from '../chat/backfill.js'
import { isBackfill } from '../chat/normalized-inbound.js'
import { createInboundAudio } from '../chat/inbound-audio.js'
import { createQuotedMessages } from '../chat/quoted-messages.js'
import { createRatelimitMiddleware, ratelimitOptionsFromEnv } from '../kernel/mw-ratelimit.js'
import { createGroupGate } from './core/group-gate.js'
import { createInboundRouter } from './core/inbound-router.js'
import { createModelSync } from './core/model-sync.js'
import { createTurnFailure, markPendingReset, takePendingReset } from './core/turn-failure.js'
import { createSessionLifecycle } from './core/session-lifecycle.js'
import { createPromptContext } from './core/prompt-context.js'
import { createToolsMount } from './core/tools-mount.js'
import { aclMsgFromInbound, textOfSegments, segmentsToContent } from './core/inbound-prep.js'
import { createInboundHydration } from '../chat/inbound-hydration.js'

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
/**
 * 临时 Outbox：内存（或指定文件）台账 + 直连 onebot 的出站实现。
 *
 * **仅供测试与降级路径**，生产必须注入 `sharedOutbox`（src/host.js 里的 SharedOutbox 是唯一
 * 物理出口，带 egress 审计、跨模块排队与来源群记忆）。这里把原先藏在 `createModularCore`
 * 里的隐式兜底提成显式函数：装配根自己不再悄悄造一个出口 —— 传了 `sharedOutbox` 就用它，
 * 没传才走这里，且 src/host.js 那一侧有断言保证生产调用点绝不会漏传。
 *
 * @param {object} o
 * @param {{ call: Function }} o.onebot
 * @param {() => object} o.getConfig
 * @param {object} o.log
 * @param {string} [o.ledgerFile] 投递台账文件（提供则落盘；缺省内存台账）
 */
function createEphemeralOutbox({ onebot, getConfig, log, ledgerFile }) {
  const ledger = ledgerFile ? createDeliveryLedger({ file: ledgerFile, onError: (e) => log.warn('投递台账落盘异常：', e.message) }) : undefined
  return createOutbox({
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
      // 只有发给主人本人的私聊才豁免主人 QQ 号（非主人私聊必须照样拦）
      const toOwner = Boolean(cfg.ownerQQ && chatKey === 'private:' + cfg.ownerQQ)
      return checkIdentityLeak(text, {
        surface: isPrivate ? '私聊消息' : '群消息',
        ids: [cfg.ownerQQ, cfg.botQQ].filter(Boolean),
        allowIds: [ownGroup, ...(toOwner ? [cfg.ownerQQ] : [])].filter(Boolean),
        // 私聊只对「已知账号」与「QQ/群号+数字」把关；裸长数字不拦（技术文档/端口/ID 会误伤整篇报告）
        allowBareNumbers: isPrivate,
        mode: ig.mode === 'warn' ? 'warn' : 'block',
      })
    },
  })
}

export function createModularCore({
  dsh, onebot, mods, getConfig, logger, log,
  personaText, runCommand, ledgerFile, sessionStoreFile, groupStateFile,
  memoryScore, isMuted, interceptInteraction, personaTextFor, onStats, noteMedia, promptVars, stickers, tts, buildTools, toolsGeneration, localApi, logChat, onResetChat, collectInboundStickers, availableModels, moduleHooks, markTurnAt, sharedOutbox, isSentMessage, inboundAudio, quotedMessages: sharedQuotedMessages, inboundImages: sharedInboundImages, inboundVision: sharedInboundVision,
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
  // 会话反查在 core/session-lifecycle.js（本函数后面才装配）：这里用惰性闭包接线，调用时才读，
  // 与拆分前「直接引用同作用域函数」的语义一致（装配期不调用，运行时才解析）。
  const participants = createTurnParticipants({ getConfig, chatOfSession: (sessionId) => sessionLifecycle.chatKeyOfSession(sessionId) })
  const presence = createPresence()
  const capture = createCapture()
  // 内容型工具（查资料的）：这一轮调过它们就按「报告」排版，不被拆碎（1.3.48 第二层兜底）。
  // 记忆型工具（recall_memory 等）刻意不在其中。集中成一处常量，免得正则漂在两个监听器里。
  const CONTENT_TOOL_RE = /^(bili_watch|heybox_(feed|watch|hot)|douyin_(watch|recent|browse)|qq_draw_image)$/

  const faces = createFaces({ onebot, log })
  const sentIds = new Set()
  const systemSessionIds = new Set() // systemTurns 后台会话 id（不进 chatOfSession，但供人设解析免误报回落告警）
  const steeringChats = new Set() // 只在 DSH 生成期接受 steer；出站期的新消息排下一轮
  /** chatKey -> 'archived' | 'context-window' | 'oversized' | 'timedOut'（下一次进入该聊天的回合时统一归档重建） */
  const pendingResets = new Map()
  const sessionTurns = new Map() // sessionId → 这个会话已经跑过多少回合（会话轮换用）
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

  // 群闸决策与在途回合账归子模块（core/group-gate.js）：状态在那里，核心只注入取数函数。
  const groupGate = createGroupGate({
    getConfig, log, debug, groups, memoryScore, atmosphereGate,
    // controller 在本函数后面才创建：与原闭包一致，取用时才读（延迟读取，不抓快照）
    getController: () => controller,
  })
  const { decideGroupReplyFor, noteTurnMode, releaseTurnMode, fishGuardOf } = groupGate

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
    // T3.4：DSH 0.2.3-alpha.2 起模型切换走 agent.model.select(target)；旧通道
    // selectForNextRequest / session.append('model/selection') 作为回退保留（老宿主仍要能跑）。
    const ctrl = ctxGet('sessionController')
    const select = ctrl?.agents?.selectForNextRequest
    let result
    if (typeof agent?.model?.select === 'function') result = await agent.model.select(target)
    else if (typeof select === 'function') result = await select.call(ctrl.agents, agent, target)
    else if (typeof agent?.session?.append === 'function') result = await agent.session.append('model/selection', target)
    else return false
    if (result === false) return false
    selectedModels.set(String(sessionId), modelKey(target))
    return true
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
  // 人设守卫的唯一口径：这张聊天现在该用哪张卡 + 这一版正文的指纹。
  // 只看 id 会漏掉「卡没换、正文改了」——那种情况 {{qq_hub_persona}} 早就把旧正文
  // 烧进会话历史了，而 DSH 不会重算，于是改字永远不生效（2026-11-23 真机）。
  const currentPersonaTarget = (chatKey) => {
    const id = currentPersona(chatKey)
    return { id, hash: personaHash(id) }
  }
  const baseSessionStore = sessionStoreFile ? createSessionFileStore({ file: sessionStoreFile }) : null
  const sessionStore = baseSessionStore && {
    load() {
      const entries = baseSessionStore.load()
      for (const [chatKey, entry] of Object.entries(entries)) {
        if (!entry?.sessionId) continue
        const personaId = entry.personaId || currentPersona(chatKey)
        const want = currentPersonaTarget(chatKey)
        const sameId = personaId === want.id
        sessionPersonas.set(chatKey, {
          sessionId: String(entry.sessionId),
          personaId,
          // 老映射没有指纹字段。若记的卡和现在这张一致，就把当前指纹当基线**不 churn**
          // （升级不该把所有会话一次性重建）；但标 assumed：这版正文到底是不是会话里
          // 那版无法确认，自检里要如实标出来，交给主人决定要不要重建。
          // 记的卡和现在不一致时指纹留空，守卫按 id 差异重建。
          personaHash: entry.personaHash || (sameId ? want.hash : ''),
          personaHashAssumed: !entry.personaHash && sameId,
        })
      }
      return entries
    },
    save(entries) {
      const enriched = Object.fromEntries(Object.entries(entries).map(([chatKey, entry]) => {
        let persona = sessionPersonas.get(chatKey)
        if (!persona || persona.sessionId !== entry.sessionId) {
          const want = currentPersonaTarget(chatKey)
          persona = { sessionId: entry.sessionId, personaId: want.id, personaHash: want.hash }
          sessionPersonas.set(chatKey, persona)
        }
        return [chatKey, {
          ...entry,
          personaId: persona.personaId,
          personaHash: persona.personaHash || '',
          ...(persona.personaHashAssumed ? { personaHashAssumed: true } : {}),
        }]
      }))
      baseSessionStore.save(enriched)
    },
  }
  // 启动后给已有映射补标题（老映射是未命名时代建的）；无存量映射就不打网关查询
  const backfillTitles = (reg) => {
    Promise.resolve().then(async () => {
      const entries = Object.entries(reg.snapshot?.() || {}).filter(([, e]) => e?.sessionId)
      if (!entries.length) return
      // 先查齐群名再逐条顺序 renameExisting（原本并发的 prefetchGroupNames + refreshGroupTitles 会重复 rename）
      for (const [chatKey] of entries) {
        if (chatKey.startsWith('group:')) await groupNameOf(chatKey.slice(6))
      }
      for (const [chatKey, entry] of entries) {
        await sessionAdapter.renameExisting?.(entry.sessionId, chatKey).catch(() => {})
      }
    }).catch(() => {})
  }
  const registry = createSessionRegistry({
    createSession: async (chatKey, hint) => {
      // 先取目标再建会话：DSH 在 create 期间（及随后的 renameSession → resolveAgent）就可能装配系统提示词，
      // 记的必须是「这一刻按哪张卡渲染的」，且通过 onCreated 在 renameSession 之前立刻登记反查表，
      // 彻底消除创建期 chatOfSession(sid) 反查不到导致人设回落全局卡的竞态。
      const want = currentPersonaTarget(chatKey)
      const registerCreated = (sid) => {
        const id = String(sid || '')
        if (!id) return
        sessionPersonas.set(chatKey, { sessionId: id, personaId: want.id, personaHash: want.hash })
        // 反查表立刻登记：装配期间 chatOfSession(sid) 必须能对上，否则渲染期会回落全局卡。
        activeChatBySessionId.set(id, chatKey)
      }
      const created = await sessionAdapter.createSession(chatKey, { ...hint, onCreated: (sid) => registerCreated(sid) })
      if (created?.sessionId) registerCreated(created.sessionId)
      return created
    },
    ...(sessionStore ? { store: sessionStore } : {}),
    onError: (e) => log.warn('session 映射持久化异常：', e.message),
  })
  backfillTitles(registry)
  const systemTurns = createSystemTurns({
    createSession: async ({ key, title, noTools }) => {
      systemTitles.set(key, String(title || 'QQ · 后台'))
      const created = await sessionAdapter.createSession(key, {
        agentPreset: presetFor(noTools ? 'chat' : 'social', getConfig()),
        onCreated: (sid) => { if (sid) systemSessionIds.add(String(sid)) },
      })
      if (created?.sessionId) systemSessionIds.add(String(created.sessionId))
      return created
    },
    resolveAgent: (sessionId) => ctxGet('sessionController')?.resolveAgent?.(sessionId),
    onEvent: (listener) => dsh.on?.('session/event', listener),
    archiveSession: (sessionId, opts = {}) => {
      systemSessionIds.delete(String(sessionId || ''))
      return (ctxGet('workspaceRegistry') ?? dsh?.workspaceRegistry)?.archiveSession?.(sessionId, { stopActivity: true, ...opts })
    },
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
      const want = currentPersonaTarget(chatKey)
      persona = { sessionId: entry.sessionId, personaId: want.id, personaHash: want.hash }
      sessionPersonas.set(chatKey, persona)
    }
    return [chatKey, {
      ...entry,
      personaId: persona.personaId,
      personaHash: persona.personaHash || '',
      ...(persona.personaHashAssumed ? { personaHashAssumed: true } : {}),
    }]
  }))

  // ---------- Context Assembly（模块上下文 + 人格） ----------
  // 注：不再把每分钟跳字的 createTimeScaleProvider 塞进 qq-hub-context 静态快照——
  // DSH runtimeContext.project() 会因内容变化每轮重印整坨 ~1.5KB <system-reminder>；
  // 而每轮消息头已有 nowLine()（精确钟点 + 距上一条间隔）与 DSH time-context，无需重复投喂。
  // 优先级：persona(1000) > legacy(100)。
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
      createLegacyContextAdapter({ mods, priority: 100 }),
    ],
  })

  // ---------- Outbox（唯一物理出口；授权/全局闸/身份闸/台账持久化全在此接线） ----------
  // 生产路径必须由 src/host.js 注入 SharedOutbox（唯一物理出口 + egress 审计）；这里只保留
  // **显式**的临时 Outbox 给测试/降级用 —— 见 createEphemeralOutbox 的说明。
  const outbox = sharedOutbox || createEphemeralOutbox({ onebot, getConfig, log, ledgerFile })

  const deliveryContext = new AsyncLocalStorage()
  // 同回合表情去重台账：工具直发 vs 正文 <sticker:…>（真机 2026-11-23 15:01 连发两张）。
  const turnStickers = createTurnStickers()
  const bump = (kind) => { presence.bump(kind); try { onStats?.(kind) } catch {} }
  const outbound = createOutbound({
    getConfig, log, onebot, outbox, groups, stickers, tts, interaction, faces,
    hooks: moduleHooks, onStats: bump, deliveryContext, turnStickers,
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
    // 审计 Q02：不再注入 reportTurns —— 报告标记改为随回合传 forceReport，
    // 投递层不需要（也不该）自己持有跨回合状态。
    getConfig, log, hooks: moduleHooks, groups, stickers,
    interaction,
    ...outbound,
    logChat,
    onActivity: (event) => mods.emit?.('activity', event),
    onDelivered: (event) => presence.noteDelivered(event),
    outbox: () => outbox,
    isCaptured: capture.isCaptured,
  })

  // 上下文/人设挂载：agent 级一次性注册（legacy mount 同型），text 闭包每轮读最新
  // 键必须是**会话 id**：resolveAgent 每轮返回新的 agent 包装对象，用对象做键永远不命中
  const ctxBoxes = new Map() // sessionId -> { text }
  const ctxBound = new Set() // 已注册过 context 的 sessionId
  const personaBound = new Set() // 已注册过 persona 变量的 sessionId
  const ctxFallback = new Set() // 宿主已占用同名 context：退回「把背景拼进消息」
  const ctxFallbackDone = new Set() // 已经投过一次的会话（避免每轮重复注入）
  const lastInboundText = new Map() // chatKey -> 上一轮入站查询文本（供记忆短句追问 prevText 使用）
  function rememberInboundText(chatKey, query) {
    const text = String(query || '').slice(-300)
    if (!text) return
    lastInboundText.delete(chatKey)
    if (lastInboundText.size >= 500) {
      const oldest = lastInboundText.keys().next().value
      if (oldest !== undefined) lastInboundText.delete(oldest)
    }
    lastInboundText.set(chatKey, text)
  }
  const activeChatBySessionId = new Map() // sessionId -> chatKey（即时反查，为人设变量/工具判定提供毫秒级保障）

  // ---------- 工具挂载 / 入站补水 / 按会话图片额度（core/tools-mount.js） ----------
  // 这三类只服务回合执行路径：把模块工具挂到 agent、把入站文件/引用水合成文本、按会话裁图进上下文。
  // 状态表（mountedTools / slowNoticeSent / imageBudget）随实现搬进子模块，但以**活引用**交回这里 ——
  // session-lifecycle 的 cleanupSession 与下面的 dispose / stats 读写的是同一份（搬实现，不复制状态）。
  const toolsMount = createToolsMount({
    getConfig, debug, log, onebot, chatViewFor, buildTools, toolsGeneration, moduleHooks,
    // outbox 在本函数后面才装配：与原闭包一致，取用时才读（延迟读取，不抓快照）
    getOutbox: () => outbox,
    // 引用三件套留在装配根（入站主链 routeInboundCore 也要用），这里只把判定传过去
    replyIdOf, quotedInfo, quoteNote,
  })
  const {
    mountTools, hydrateInboundFiles, trimToImageBudget, resetImageBudget,
    mountedTools, slowNoticeSent,
  } = toolsMount

  // 入站水合链（合并转发 → 语音转写 → 入站文件 → 引用转述）归 chat/inbound-hydration.js：
  // execute 与 steer 两条路共用同一份顺序。依赖全是活引用（onebot / audio / toolsMount）。
  const { hydrateMembers } = createInboundHydration({ onebot, log, audio, toolsMount })

  const admitContent = async (content, context = {}) => {
    const { content: trimmed } = trimToImageBudget(content, context.sessionId && String(context.sessionId), context.cfg || getConfig())
    // T3.10：视觉判定要看「这一轮真正跑的会话模型」，不是配置里的默认模型 —— 与 4.5 步
    // （applySessionModel）用同一个 resolveTarget 口径，否则两者会对不上：
    // 切了会话模型却还按默认模型判图，该转述的没转述、不该发图的发了图。
    let target = context.target || null
    if (!target && context.chat) {
      try { target = await resolveTarget(context.chat) } catch (error) { debug(`视觉判定取会话模型失败（用默认）：${error?.message || error}`) }
    }
    if (target) context.target = target
    return inboundVision.admit(trimmed, context)
  }

  // 会话生命周期（清理 / 重置 / 人设变更重置 / 全量重置 / 孤儿巡检 / 清单 / 反查 / 会话取用）
  // 归子模块（core/session-lifecycle.js）。会话状态表是 Map/Set 活引用：核心主链与它读写同一份；
  // 人设目标以 currentPersonaTarget 取数注入（会话映射那一侧也读同一个，不复制快照）。
  // resetChat 的归档是异步的：这张表记录「刚归档、尚未落地」的会话，供人设变量求值时免误报
  const recentlyArchivedSessions = new Map() // sessionId -> expiresAt
  const sessionLifecycle = createSessionLifecycle({
    dsh, getConfig, log, debug, onResetChat, ctxGet, chatViewFor,
    currentPersonaTarget,
    registry, systemTurns, participants, groupNames, resetImageBudget,
    sessionPersonas, lastInboundText, sessionTurns, activeChatBySessionId,
    ctxBoxes, ctxBound, ctxFallback, ctxFallbackDone, personaBound,
    mountedTools, slowNoticeSent, selectedModels, pendingResets,
    recentlyArchivedSessions, sessionAdapter,
  })
  const {
    cleanupSession, resetChat, resetChatsForPersonaChange, resetAllSessions,
    sweepOrphanSessions, knownChats, chatKeyOfSession, isArchivingSession, sessionForChat,
  } = sessionLifecycle

  // 会话取用 / 轮换 / 归档探测（sessionForChat）同样在子模块里：它是「每一轮的唯一入口」
  // （execute 与 runPromptTurn 都过这里）；它读的人设指纹、回合计数、图片额度都是活引用，
  // 与 execute 主链看同一份（拆的是实现，不是状态）。

  // 回合失败（超时 / 请求体过大 / 被归档门拦下）的标记与提示归子模块（core/turn-failure.js）。
  // 待重置标记表以活引用传入：execute / runPromptTurn 读的仍是同一份。
  const turnFailure = createTurnFailure({
    log, debug, getOutbox: () => outbox,
    pendingResets,
  })
  // 注意：`handleTurnFailure` 这个名字已归 #263 的分类回执（本文件内定义）；子模块的统一分派
  // 入口此处不取出（两侧语义不同，串了就丢回执）。三个既有 handler 直接取模块实现。
  const { handleTurnTimeout, turnFailureLooksOversized, handleOversizedTurn, handleArchivedTurn } = turnFailure

  // DSH 回合执行器（S2）：聊天主链（execute）与后台主动回合（runPromptTurn）共用同一套
  // 事件机 / 超时 / 取消 / 失败分类。两条链独有的语义（typing、表情台账、群缓冲标 fed、
  // 投递、steer 上下文拼装、模型与人设挂载）仍留在各自调用点，一行都没搬。
  const turnRunner = createTurnRunner({
    dsh, ctxGet, getConfig, log, debug,
    classifyFailureKind: turnFailure.classifyFailureKind,
  })

  // ---------- 回合失败回执（2026-11-27） ----------
  // 问题：413 / 超时 / blocked 都有回执，**其余失败一律静默** —— 上游内容策略 403、限流 429、
  // 模型抖动都会让这一轮在 QQ 侧一个字都不出现。用户只看到她「没听见」，只有翻后台日志
  // 才知道被拒了（真机 11-27 14:29/14:30：两条「你不能帮我查保修吗」被网关
  // codearts_upstream 403 判成非编程话题，QQ 上全程沉默）。
  //
  // 这里给「分类 + 限频回执」：让用户知道这轮没成、且不是她的态度问题，同时避免模型
  // 持续挂掉时每轮刷屏（同聊天一个窗口内最多提示一次）。

  const FAILURE_NOTICE_WINDOW_MS = 5 * 60_000
  /**
   * 「模型通道整体挂了」这一类失败：不是某条消息的内容问题，也不是某个群的偶发抖动，
   * 而是她所有回复都会失败、且**需要主人动手**（查余额 / 调限制器 / 换模型）。
   * 群聊里遇到这类失败不能沉默 —— 改投主人私聊（见 handleTurnFailure 的收件人选择）。
   */
  // 群聊里「网关整体不可用」的失败改投主人私聊：限流等一会儿会好，欠费/余额耗尽则必须主人动手。
  const GATEWAY_LEVEL_KINDS = new Set(['rate-limit', 'billing'])
  const failureNoticedAt = new Map() // `${chatKey}::${kind}` → 上次发失败回执的时间（LRU 顺序）

  /** 上游内容策略拦截：只认「被服务端判敏感/不让答」这类，绝不是功能坏了。 */
  const MODERATION_TEXT = /content.?policy|content_filter|finish_reason:\s*content_filter|input.?new.?sensitive|敏感内容|内容.{0,4}(?:审核|合规|敏感)|risk.?control|security_check|inappropriate|prohibited|PROHIBITED_CONTENT|safety.?filter|data_inspection_failed|codearts_upstream|无法提供(?:关于|该|此|任何)?[^\n]{0,16}(?:建议|帮助|内容|回答|信息)|不能提供关于|not\s+able\s+to\s+(?:help|assist|provide)|(?:"code"\s*:\s*"?(?:1026|1027|2013)"?|"(?:1026|1027|2013)")/i
  const MODERATION_CODE = /^(?:codearts_upstream|data_inspection_failed|prohibited_content|content_filter|content_policy|safety_filter|1026|1027|2013)$/i
  /** 纯认证 / 权限类 403：不是内容审核，避免误导用户「换个说法」。 */
  const AUTH_FORBIDDEN_TEXT = /invalid[_\s-]*api[_\s-]*key|api[_\s-]*key|unauthorized|unauthenticated|authentication|auth[_\s-]*failed|invalid[_\s-]*token|expired[_\s-]*token|forbidden[_\s-]*token|access[_\s-]*denied|permission[_\s-]*denied|not[_\s-]*authorized|no[_\s-]*permission|invalid[_\s-]*credentials|account[_\s-]*(?:disabled|suspended|locked)|认证失败|鉴权|密钥无效|无权限|权限不足/i
  const AUTH_FORBIDDEN_CODE = /^(?:AUTH_ERROR|AUTHENTICATION_ERROR|UNAUTHORIZED|INVALID_API_KEY|PERMISSION_DENIED|FORBIDDEN_TOKEN)$/i
  /** 欠费 / 余额不足（非限流）：等一会儿不会好，诚实提示检查配置或换模型。 */
  const BILLING_TEXT = /余额不足|欠费|insufficient_balance|insufficient_quota|payment[_\s-]*required|\b402\b/i
  const BILLING_CODE = /^(?:INSUFFICIENT_BALANCE|INSUFFICIENT_QUOTA|PAYMENT_REQUIRED|BILLING_ERROR)$/i
  /** 明确限流特征（用于与欠费/余额不足区分）。 */
  const EXPLICIT_RATE_LIMIT_TEXT = /\b429\b|rate.?limit|频率限制|冷却|reset_at|routing_cooldown|限制器|无账号可转发/i
  /** 限流 / 配额：等一会儿或换模型就能恢复，不是永久故障。 */
  const RATE_LIMIT_TEXT = /\b429\b|rate.?limit|频率限制|(?<!insufficient_)quota|限额|额度|冷却|reset_at|routing_cooldown|overloaded|capacity|限制器|无账号可转发/i
  const RATE_LIMIT_CODE = /^(?:RATE_LIMITED|RATE_LIMIT|TOO_MANY_REQUESTS|ROUTING_COOLDOWN)$/i
  /** 上下文超窗（模型窗口不够，不是请求体字节过大）：提示用户下一条消息会重新开始。 */
  const CONTEXT_WINDOW_TEXT = /context.?window|上下文.{0,6}(?:超|满|不够|溢出)|maximum\s+context|too\s+many\s+tokens|CONTEXT_WINDOW_EXCEEDED/i

  /**
   * 把回合失败归类成用户能懂的一类。
   * @param {unknown} error 失败原因（Error 或 DSH 的 failure 对象）
   * @returns {{kind: string, text: string}} kind 用于日志/面板，text 是要发给用户的原话
   */
  function classifyTurnFailure(error) {
    const msg = String(error?.failure?.message || error?.message || error || '')
    const code = String(error?.failure?.code || error?.code || '')
    const status = Number(error?.failure?.status || error?.status) || 0
    const isExplicitRateLimit = status === 429 || RATE_LIMIT_CODE.test(code) || EXPLICIT_RATE_LIMIT_TEXT.test(msg)
    const isBilling = status === 402 || BILLING_CODE.test(code) || BILLING_TEXT.test(msg)
    const isModeration = MODERATION_TEXT.test(msg)
      || MODERATION_CODE.test(code)
      || (status === 403 && !AUTH_FORBIDDEN_TEXT.test(msg) && !AUTH_FORBIDDEN_CODE.test(code) && !isBilling && !isExplicitRateLimit)
    if (isModeration) {
      return {
        kind: 'moderation',
        text: '这条被模型服务端的内容审核拦了（不是我不理你，是上游直接拒了），换个说法再说一次？',
      }
    }
    if (isBilling && !isExplicitRateLimit) {
      return {
        kind: 'billing',
        text: '模型账号额度/余额不够了，找主人检查一下配置或换个模型吧。',
      }
    }
    if (isExplicitRateLimit) {
      return {
        kind: 'rate-limit',
        text: '模型这会儿限流了，等一会儿再找我（或者换一个模型）。',
      }
    }
    if (code === 'CONTEXT_WINDOW_EXCEEDED' || CONTEXT_WINDOW_TEXT.test(msg)) {
      return {
        kind: 'context-window',
        text: '会话攒得太长，模型的窗口装不下了。你发下一条消息时我会重新开始（旧对话还归档着）。',
      }
    }
    if (RATE_LIMIT_TEXT.test(msg)) {
      return {
        kind: 'rate-limit',
        text: '模型这会儿限流了，等一会儿再找我（或者换一个模型）。',
      }
    }
    return {
      kind: 'error',
      text: '这轮没跑成（网络或模型那边抖了一下），再跟我说一次？',
    }
  }

  /**
   * 回合非 413 / 非超时 / 非 blocked 的失败：按类别发一条诚实的回执（限频）。
   *
   * 按 `${chatKey}::${kind}` 限频（同聊天同类别 5 分钟一次）：模型持续挂掉时不会刷屏，
   * 且前一次普通网络抖动不会把 5 分钟内的内容审核 / 限流 / 超窗提示吞掉；
   * 命中 `context-window` 时无论私聊还是群聊都登记待重置，确保下一条消息真正换新会话。
   * @param {string} chatKey 聊天键
   * @param {unknown} error 失败原因
   * @param {{notify?: boolean}} [opts] notify=false 时只记日志不发消息（试探/测试路径用）
   * @returns {{kind: string, sent: boolean}} 分类结果与是否真的发出
   */
  function handleTurnFailure(chatKey, error, { notify = true } = {}) {
    const key = String(chatKey || '')
    const { kind, text } = classifyTurnFailure(error)
    const detail = String(error?.failure?.message || error?.message || error || '').replace(/\s+/g, ' ').slice(0, 160)
    log.warn(`回合失败（${kind}）：${key}${detail ? '：' + redact(detail) : ''}`)
    // 上下文超窗（模型窗口不够）：无论私聊还是群聊，只要 key 非空即登记待重置，
    // 兑现「下一条消息重新开始」的承诺（群聊虽不发提示也要能自愈，避免一直卡死）。
    if (key && kind === 'context-window') markPendingReset(pendingResets, key, 'context-window')
    if (!notify || !key) return { kind, sent: false }
    // 收件人选择：
    //   · 私聊 → 发给对方（「她的对话被掐了」，对方该知道）；
    //   · 群聊 → **默认不发**（在群里解释技术故障对群友是噪音），
    //     但「模型通道整体挂了」这类**不是某个群的问题、且需要主人动手**的故障，
    //     改投**主人私聊** —— 否则群里的失败对主人完全不可见，要翻后台日志才知道
    //     （真机 2026-11-27 21:45~22:09：某个群连续 7 轮
    //      503「所有启用中的账号都被限制器拦下，无账号可转发」，全程零提示）。
    let targetKey = key
    let rateKey = `${key}::${kind}`
    if (!key.startsWith('private:')) {
      if (!GATEWAY_LEVEL_KINDS.has(kind)) return { kind, sent: false }
      const ownerQQ = String(getConfig()?.ownerQQ || '')
      if (!ownerQQ) return { kind, sent: false }
      targetKey = `private:${ownerQQ}`
      // 网关级故障是**全局**的：同一段时间里多个群都会失败。按 kind 全局限频，
      // 避免主人被「每个群各发一条」刷屏。
      rateKey = `__gateway__::${kind}`
    }
    const now = Date.now()
    const last = Number(failureNoticedAt.get(rateKey) || 0)
    if (last && now - last < FAILURE_NOTICE_WINDOW_MS) {
      // 命中热 key 时刷新 LRU 顺序，避免活跃条目被误淘汰
      failureNoticedAt.delete(rateKey)
      failureNoticedAt.set(rateKey, last)
      debug(`失败回执限频：${rateKey} 距上次提示不足 ${Math.round(FAILURE_NOTICE_WINDOW_MS / 60000)} 分钟，只记日志`)
      return { kind, sent: false }
    }
    failureNoticedAt.delete(rateKey)
    failureNoticedAt.set(rateKey, now)
    if (failureNoticedAt.size > 200) {
      // LRU 自愈：删掉最久未访问的一条，避免 Map 无限增长
      const oldest = failureNoticedAt.keys().next().value
      if (oldest !== undefined) failureNoticedAt.delete(oldest)
    }
    const rollbackRate = () => {
      if (failureNoticedAt.get(rateKey) === now) {
        if (last) {
          failureNoticedAt.delete(rateKey)
          failureNoticedAt.set(rateKey, last)
        } else {
          failureNoticedAt.delete(rateKey)
        }
      }
    }
    try {
      // 群聊改投主人私聊时补一句「哪个群」，否则主人不知道去看哪儿。
      const body = targetKey === key ? text : `${text}\n（${key} 这一轮没回成）`
      Promise.resolve(outbox.request({
        chatKey: targetKey, sourceModuleId: 'core',
        segments: [{ type: 'text', data: { text: body } }],
      })).then((res) => {
        if (res && (res.ok === false || res.state === 'failed')) rollbackRate()
      }, (err) => {
        rollbackRate()
        debug(`失败回执没发出去：${err?.message || err}`)
      })
    } catch (err) {
      rollbackRate()
      debug(`失败回执没发出去：${err?.message || err}`)
      return { kind, sent: false }
    }
    return { kind, sent: true }
  }
  // ---------- Turn Controller（执行 = 会话轮次 + 装配 + 投递） ----------
  // 群聊上下文拼接归子模块（core/prompt-context.js 的 groupPromptContent）：它读的群缓冲 /
  // 群名缓存都是活引用，execute 主链拿到的 blocks / refs / fedItems 与拆分前是同一份对象。
  const promptContext = createPromptContext({ getConfig, groups, groupNames })
  const { groupPromptContent } = promptContext

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
      const offeredMode = groupGate.turnModeOf(turn.turnId)
      // #263 的外层兜底在失败时调它摘监听。S2 起监听器归执行器（成功 / 失败 / 取消 / 超时四条路径
      // 都在 runTurn 里摘干净），所以这里恒为空操作 —— 保留这处接线只为让 #263 那段兜底的结构
      // 与语义一字不变（不新增、也不删掉一层清理）。
      const cleanupTurnListener = () => {}
      try {
      // 上一轮失败留下的待重置标记：统一取出（取出即清除，同一个理由只 reset 一次）。
      // 理由只决定要不要留原文案：413 与归档门各有一条既有 info（文案一字未改），超时原来不打日志。
      const pendingReset = takePendingReset(pendingResets, turn.chatKey)
      if (pendingReset) {
        // 413 / 请求体过大：旧历史每轮重放必然再 413，只有换会话能救。
        // 归档门 blocked：映射还指着已归档会话，不换就每轮都被拦。
        resetChat(turn.chatKey)
        if (pendingReset === 'oversized') log.info(`请求体过大自愈：${turn.chatKey} 的旧会话已归档，本轮用新会话回答`)
        else if (pendingReset === 'archived') log.info(`归档自愈：${turn.chatKey} 的旧会话已归档，本轮用新会话回答`)
        // 上一轮因模型上下文超窗（context-window）失败：归档旧会话重建，兑现「下一条消息重新开始」。
        else if (pendingReset === 'context-window') log.info(`上下文超窗自愈：${turn.chatKey} 的旧会话已归档，本轮用新会话回答`)
      }
      const chat = chatViewFor(turn.chatKey, io.members)
      const inGroup = chat.kind === 'group'
      // 排队期间前序回合已选 [沉默] 退场或话题窗口已过期：纯 engaged 续聊不再浪费模型调用、也不复活话题。
      if (inGroup && offeredMode === 'engaged' && !(groups.engagedUntil(chat.groupId) > Date.now())) {
        debug(`群 ${chat.groupId}：排队中的续聊回合 ${turn.turnId} 已退场/过期，跳过执行`)
        return null
      }
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
      let groupTriggerReply = null
      let groupFreshLast = null
      let groupFreshLastAt = 0
      // 本轮选中、待模型消费后才标 fed 的群缓冲条目（缺陷：群缓冲静默丢消息）。
      let groupFedItems = null
      let content
      // 真机审计 1.4：先把语音段转成文字，再拼内容（群/私聊两条路都受益）
      // 四步水合（转发→语音→文件→引用）归 chat/inbound-hydration.js；群缓冲的「正文回填」
      // 必须发生在文件水合**之前**（文件水合会把 file 段换成整份正文，进缓冲会撑爆上下文），
      // 所以用 onHeard 拿到那个中间态，时序与拆分前逐行一致。
      const members = await hydrateMembers(io.members, turn.chatKey, inGroup ? {
        onHeard: (list) => {
          for (const member of list) {
            const hit = groups.buffer(chat.groupId).findLast((x) => x.mid && x.mid === String(member.messageId || ''))
            if (hit) hit.text = textOfSegments(member.segments)
          }
        },
      } : undefined)
      if (inGroup) {
        for (const member of members) {
          if (member?.quoteNote) {
            const hit = groups.buffer(chat.groupId).findLast((x) => x.mid && x.mid === String(member.messageId || ''))
            if (hit) hit.quoteNote = member.quoteNote
          }
        }
      }
      const previousTurnAt = turnAt(turn.chatKey)
      let promptQuery = textOfSegments(io.members.flatMap((m) => m.segments || []))
      if (inGroup) {
        const gp = groupPromptContent(turn.chatKey, members, previousTurnAt, offeredMode)
        content = gp.blocks
        turnMode = gp.mode
        autoReply = gp.autoReply
        groupTriggerReply = gp.triggerReply
        groupFreshLast = gp.freshLast
        groupFreshLastAt = gp.freshLastAt
        groupFedItems = gp.fedItems
        if (gp.query) promptQuery = gp.query
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
      const prevPromptText = lastInboundText.get(turn.chatKey) || ''
      if (typeof moduleHooks?.prompt === 'function') {
        const next = await moduleHooks.prompt(content, {
          chat, sessionId, senderId: chat.userId, prevText: prevPromptText, queryText: promptQuery,
        })
        if (next == null) return null
        content = next
      }
      rememberInboundText(turn.chatKey, promptQuery)
      const ctxText = fragments.map((f) => f.content).join('\n')
      // 4. 驱动 DSH 会话轮次（resolveAgent → followup；steer 输入注册给后续转向）
      //    sessionController 只能走 ctx.get（真机报告 3：cordis 未声明 inject 的 .services 直接点会抛）
      //    S2：resolveAgent 与 followup 守卫归 chat/dsh-turn-runner.js（两条链同一份文案）。
      //    这里拿到的 agent 必须继续用下去（挂工具/模型/上下文），不能二次 resolve ——
      //    宿主每轮返回新的包装对象，换一份就挂不上了。
      const agent = await turnRunner.resolveAgentFor(sessionId)
      mountTools(agent, turn.chatKey, sessionId) // 模块工具（qq_send_*、记忆、B站、群管…）
      let activeSteers = 0
      // T3.2：本轮是否已结束（turn/end 或 cleanup）。水合/看图是异步的，期间旧回合可能已经
      // 收尾落定；此时再 agent.steer 就是给 idle agent 发孤儿转向，追问会被静默吞掉。
      const turnState = { isTurnEnded: () => false, canSteer: () => true }
      // 收尾函数：活跃 steer 全部落定后由这里驱动（即拆分前的 finishReply 变量，语义未变；
      // 真正的实现由 turnRunner 通过 collect.onFinish 交回来）。
      let finishReply = () => {}
      io.onSteer(async (inbound) => {
        activeSteers++
        try {
          const quotedSteer = await hydrateMembers([inbound], turn.chatKey)
          let steerContent = segmentsToContent(quotedSteer)
          const source = `【私聊】${neutralizeInboundDsl(String(inbound.sender?.nickname || inbound.sender?.userId || ''))}(${inbound.sender?.userId})：`
          const timeHead = nowLine(Date.now(), previousTurnAt)
          const index = steerContent.findIndex((block) => block.type === 'text')
          if (index >= 0) steerContent[index] = { ...steerContent[index], text: `${source}\n${timeHead}\n${steerContent[index].text || ''}` }
          else steerContent.unshift({ type: 'text', text: `${source}\n${timeHead}\n` })
          const stickerPick = stickerPicks.get(inbound)
          if (stickerPick) steerContent.push({ type: 'text', text: stickerHint(stickerPick) })
          const steerQuery = textOfSegments(inbound.segments)
          const prevSteerText = lastInboundText.get(turn.chatKey) || ''
          try { participants.note(String(sessionId), [String(inbound.sender?.userId || '')].filter(Boolean), { chatId: turn.chatKey, queryText: steerQuery }) } catch {}
          if (typeof moduleHooks?.prompt === 'function') {
            const next = await moduleHooks.prompt(steerContent, { chat, sessionId, senderId: chat.userId, prevText: prevSteerText, queryText: steerQuery, steer: true })
            if (next == null) return
            steerContent = next
          }
          rememberInboundText(turn.chatKey, steerQuery)
          const admittedSteer = await admitContent(steerContent, {
            nickname: inbound.sender?.nickname || inbound.sender?.userId,
            hint: textOfSegments(inbound.segments), cfg: getConfig(), sessionId, chat,
          })
          // 水合/看图/预处理全部结束后再复查一次：旧回合若已结束，抛错让
          // inbound-router 的 .catch(() => controller.offer(inbound)) 把它当新回合重跑。
          if (turnState.isTurnEnded() || (agent.status && agent.status !== 'running')) {
            throw new Error('turn-ended-before-steer')
          }
          await agent.steer({ id: randomUUID(), role: 'user', content: admittedSteer, source: { kind: 'qq-hub' } })
        } finally {
          activeSteers--
          // 收尾函数内部自己判「有没有 turn/end、followup 是否兑现、还有没有活跃 steer」，
          // 与原 `if (followupDone && !activeSteers) finishReply()` 等价（闸门搬进执行器）。
          finishReply()
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

      // 5. 等**回合结束**（不是首个 assistant/message）：事件机（分段拼接 / 末步回退 / 报告标记 /
      //    超时 / 取消 / 监听器摘除）统一归 chat/dsh-turn-runner.js 的 runTurn：
      //    - assistant/message：跳过 interrupted 的部分内容，记下本 turn 文本（可能多条取最后）；
      //    - turn/end：completed 且有文本才收尾；非 completed 如实失败（不发、释放调度槽）；
      //    - followup rejection：捕获，回合落定异常，finally 清理监听器（防句柄泄漏）。
      //    这里只保留本链独有的两件事：报告标记本体（回合作用域）与「活跃 steer 未落定先不收尾」。
      // 审计 Q02：报告兜底标记改为**回合作用域**。
      // 过去是 `reportTurns: Map<chatId, true>`：tool/call 时 set，turn/end 时 delete，
      // 而投递发生 turn/end 之后 —— 于是兜底规则一次都没生效过。改成随这轮对象活到底，
      // 顺带消掉「上一轮的快照污染下一轮」这个跨回合泄漏。
      const turnReportHit = { hit: false }
      const collect = {
        mode: 'chat',
        // 内容型工具在 tool/call 时打在本轮对象上（CONTENT_TOOL_RE 只在装配根保留一份）
        onToolCall: (ev) => { if (CONTENT_TOOL_RE.test(String(ev?.data?.name || ''))) turnReportHit.hit = true },
        // 还有 steer 在跑就先不收尾（拆分前 finishReply 的 `!activeSteers` 闸）
        holdSettle: () => activeSteers > 0,
        // 把收尾函数交给调用方：steer 的 finally 要能驱动它（拆分前是同一个闭包变量）
        onFinish: (finish) => { finishReply = finish },
      }
      // 5.5 消息完整形状（真机报告 1：DSH agent-loop 的 isOwned(message) 读 message.source.kind，
      //     只传 {content} 会在 turn/start 后 8ms 以 error 结束）。对齐 legacy hub.js:1902。
      const admitted = await admitContent(content, {
        nickname: chat.nickname || chat.userId,
        hint: textOfSegments(io.members.flatMap((member) => member.segments || [])), cfg: getConfig(), sessionId, chat,
      })
      const message = { id: randomUUID(), role: 'user', content: admitted, source: { kind: 'qq-hub' } }
      // 「正在输入」对齐 legacy（hub.js:1903 起 / turn/end 停）：私聊、enabled/dryRun 门在 startTyping 内部；
      // 现网新核心此前不亮 typing（转正补齐的 e2e 平账项）。
      activity.startTyping(String(sessionId), chat, getConfig(), pingTyping)
      // 回合起点清表情台账：工具直发（qq_send_sticker）与本回合正文去重是同一份账，
      // 不能让上一轮直发过的表情把这一轮的正常发表情误伤掉（见 chat/turn-stickers.js）。
      turnStickers.clear(turn.chatKey)
      steeringChats.add(turn.chatKey)
      const stopTyping = () => { try { activity.stopTyping(String(sessionId)) } catch {} }
      let reply
      // S2 行为改动（唯一一处）：把 io.signal 交给执行器 —— 取消请求到达时回合立刻以 AbortError
      // 落定（回合落 cancelled），迟到回复不再投递。拆分前这个信号「传了但没人读」。
      try {
        const result = await turnRunner.runTurn({ sessionId, message, collect, signal: io.signal, agent, turnState })
        reply = result.text
        steeringChats.delete(turn.chatKey)
        stopTyping()
      } catch (error) {
        steeringChats.delete(turn.chatKey)
        stopTyping()
        // 取消（AbortError，S2 的 io.signal）：回合落 cancelled、零投递，**不发任何回执** ——
        // 这是用户/宿主主动中止，不是故障，#263 的「失败回执」只针对故障。先标 _turnFailureHandled，
        // 让外层兜底也跳过（否则会补发一条「这轮没跑成」）。分类字段不带 timedOut/oversized/archived，
        // 不标这个的话后面每个分支都会把它当成普通 error。
        if (error?.name === 'AbortError' || error?.kind === 'cancelled') {
          if (error && typeof error === 'object') error._turnFailureHandled = true
          throw error
        }
        // 超时 / 请求体过大 / 归档门 / 其余失败：#263 的四个出口分工照旧，只是分类字段由执行器给出
        //（`timedOut` / `oversized` / `archived`），不再靠 message 匹配。
        if (error?.timedOut) handleTurnTimeout(turn.chatKey, error.timedOutForMs)
        else if (error?.oversized) handleOversizedTurn(turn.chatKey, error.cause ?? error)
        // `blocked` = DSH 归档门在 pre-step 就把这一回合拒了（一个模型调用都没发生）：
        // 光记一条 warn 不够，映射还指着那个已归档会话，下一轮同样 blocked —— 必须换会话。
        // 这里只记标记，真正 resetChat 放在下一次进入 execute 时做（与超时/413 同款时序）。
        else if (error?.archived) handleArchivedTurn(turn.chatKey)
        else handleTurnFailure(turn.chatKey, error.cause ?? error)
        // 外层兜底靠这个标记去重（否则 413 / 超时会各发两遍提示）。
        if (error && typeof error === 'object') error._turnFailureHandled = true
        throw error
      }

      // 模型已确实消费这段群输入（拿到回复）→ 此刻才把选中的 fresh 标 fed。
      // 之前任何失败路径（followup 抛错、回合超时、turn/end 异常）都已 throw，不会走到这里，
      // 那些消息保持 unfed，下一轮重新作为 fresh 喂入，不静默丢（缺陷：群缓冲静默丢消息）。
      // 只标选中的 fresh（≤20），突发超量时未选中的新消息仍 unfed，留给下一轮。
      if (groupFedItems) for (const x of groupFedItems) x.fed = true

      // 6. 出站后处理（真机报告 6：不处理后处理链时 `|||` 字面外发）：
      //    stripReasoning、按 ||| 分气泡（maxBubbles 上限由 replyRules 收敛）、[沉默] 不说话——与 legacy 同一函数。
      //
      // 审计 Q01：这里**不再**自己跑一遍 reply / reply:items 钩子与 parseReply。
      // 过去两处各跑一次（本函数 + reply-delivery.deliverNow），有状态或非幂等的扩展会重复
      // 执行；而且第一次解析出的 replyItems 只喂给了线索账本，线索看到的内容可能不是实际
      // 发出的内容。现在唯一的执行点就是 deliver()，它把「实际发出的条目」作为 items 交回来。
      if (!reply) return null
      // 群聊 interject/engaged 发前滞后漂移复核：生成期间若群里又刷了很多新消息，
      // 防止没有引用的回复变成「穿越发言」；中等漂移（2~5 条）自动补挂引用指向触发消息。
      if (inGroup && (turnMode === 'interject' || turnMode === 'engaged')) {
        const curBuf = groups.buffer(chat.groupId)
        const anchorIdx = groupFreshLast ? curBuf.lastIndexOf(groupFreshLast) : -1
        const afterAnchor = anchorIdx >= 0
          ? curBuf.slice(anchorIdx + 1)
          : curBuf.filter((x) => Number(x.t || 0) > groupFreshLastAt)
        const drift = afterAnchor.filter((x) => !x.self && !x.officialBot).length
        const hasExplicitReply = /<reply[:：]\s*[^<>|\n]{1,40}?>|\[reply[:：]\s*[^\]\[|\n]{1,40}?\]/.test(reply)
        if (drift >= 6 && !hasExplicitReply) {
          log.info(`${turn.chatKey}：生成期间群里已新增 ${drift} 条消息且回复未带引用，放弃发送以免穿越发言`)
          return null
        }
        if (drift >= 2 && !hasExplicitReply && !autoReply && groupTriggerReply) {
          autoReply = groupTriggerReply
        }
      }
      // 这一轮真正进模型的用户原话：投递、线索、关系信号三处都用同一份（不再各算一次）。
      const turnUserText = textOfSegments(io.members.flatMap((m) => m.segments || []))
      try {
        let delivered = null
        try {
          delivered = await replyDelivery.deliver(turn.chatKey, reply, {
            own: true,
            topicMode: turnMode || undefined, // 续聊不刷新话题窗口的分派依据（见 reply-delivery）
            userText: turnUserText,
            wantVoice: wantsVoice(turnUserText),
            autoReply,
            refs: inGroup ? groups.refs(chat.groupId) : {},
            // 审计 Q02：报告兜底标记随**回合**传进来，不再走一个「聊天天键」的 Map
            // （那个 Map 在 turn/end 就被删掉，而投递发生在其后，规则永远读不到它）。
            forceReport: turnReportHit.hit,
            // 本回合已经直发过的表情（工具 qq_send_sticker）：正文里的同一张不再重复发。
            stickersSentThisTurn: () => turnStickers.sentIn(turn.chatKey),
          })
        } finally {
          // 投递结束就清账：台账只服务本回合，留到下一轮会误伤正常的发表情。
          turnStickers.clear(turn.chatKey)
        }
        // 她选择沉默 / 模块拦下：与旧的 parsed.silent、next==null 语义一致，整轮不投递。
        if (!delivered) return null
        if (delivered.state === 'silent') return null
        // 插话配额只跟随「真的说出去了」（审计 Q06）：全失败/零尝试不再计一次插话。
        if (inGroup && (delivered.state === 'sent' || delivered.state === 'partial')) {
          try { if (turnMode === 'interject') groups.noteInterject(chat.groupId) } catch {}
        }
        // 如实上报（缺陷：轮次级谎报）。终态由投递层给出，这里不再自己反推：
        //   · sent    —— 可发条目全部拿到网关回执
        //   · partial —— 有气泡没拿到回执（已发出的不重发，避免重复说话）
        //   · failed  —— 有可发条目但一条回执都没拿到
        //   · skipped —— 整轮没有可发条目
        // 审计 Q06 修掉了旧行为里「attempted 为 0 也算 sent」：那会让「没说出口」
        // 在台账和面板上显示成「说过」。
        const failed = Number(delivered?.failedCount) || 0
        const state = delivered?.state || (failed > 0 ? 'partial' : 'sent')
        if (state === 'partial') {
          log.warn(`${turn.chatKey}：本轮投递归属 partial（${delivered?.delivered ?? '?'}/${delivered?.attempted ?? '?'} 条拿到回执）`)
        } else if (state === 'failed') {
          log.warn(`${turn.chatKey}：本轮 ${delivered?.attempted ?? '?'} 条气泡全部没有拿到网关回执`)
        }
        return { state, via: 'reply-delivery', failedCount: failed, attempted: delivered?.attempted, delivered: delivered?.delivered }
      } catch (error) {
        log.warn(`回复发送失败：${error?.message || error}`)
        // 已成功发出部分气泡后再抛错（error.delivered > 0）：用户已经看到前面的回复，
        // 不再补发「这轮没跑成」造成困惑；只有 0 气泡送达且尚未处理过的失败才发回执。
        try {
          const partialDelivered = Number(error?.delivered) > 0
          if (!partialDelivered && !error?._turnFailureHandled && !(error?.timedOut || error?.turnTimedOut) && !turnFailureLooksOversized(error?.failure || error)) {
            handleTurnFailure(turn.chatKey, error)
          }
        } catch { /* 回执失败绝不影响回合终态 */ }
        if (error && typeof error === 'object') error._turnFailureHandled = true
        throw error
      }
      } catch (error) {
        cleanupTurnListener()
        // 外层统一兜底：覆盖 sessionForChat / assembly.assemble / resolveAgent / !agent.followup / admitContent
        // 等前置阶段的漏网异常；内部已处理过的错误已标 _turnFailureHandled=true，这里绝不重复发回执。
        try {
          if (!error?._turnFailureHandled) {
            if (error?.timedOut || error?.turnTimedOut) {
              handleTurnTimeout(turn.chatKey, Math.max(1, Number(getConfig().turnTimeoutMs) || 600_000))
            } else if (turnFailureLooksOversized(error?.failure || error)) {
              handleOversizedTurn(turn.chatKey, error?.failure || error)
            } else if (!(Number(error?.delivered) > 0)) {
              handleTurnFailure(turn.chatKey, error)
            }
            if (error && typeof error === 'object') error._turnFailureHandled = true
          }
        } catch { /* 回执失败绝不影响回合终态 */ }
        throw error
      } finally {
        releaseTurnMode(turn.chatKey, turn.turnId)
      }
    },
  })

  // ---------- 入站路由层（core/inbound-router.js） ----------
  // 入站主链（ACL → 旁路 → 开关 → 静音 → 群缓冲 → 群闸 → offer）、legacy 兼容入口、
  // 补收入口全部归子模块。依赖一律是活引用：controller / outbox / groups / interaction /
  // presence 是同一份对象，stickerPicks / steeringChats / backfillMeta 是同一份 WeakMap/Set
  //（execute 主链与它读写同一份 —— 拆的是实现，不是状态）。
  const inboundRouter = createInboundRouter({
    getConfig, log, debug, gatedDebug,
    mods, moduleHooks, runCommand,
    controller, outbox, groups, groupGate,
    interaction, presence,
    stickerPicks, steeringChats, backfillMeta,
    replyIdOf, quotedInfo, quoteNote, rateAllowed,
    interceptInteraction, isMuted, noteMedia, onStats, logChat, collectInboundStickers,
  })
  const { dispatchLegacyEvent, dispatchLegacyEventSettled, dispatchBackfill, selfId: selfIdOf } = inboundRouter

  /** 主动任务共用一个 QQ/DSH 会话，只生成文本，不在这里自动投递（调用方仍走统一 Outbox）。 */
  async function runPromptTurn(chatKey, text) {
    return controller.runExclusive(chatKey, async () => {
      // 与主链同款：上次失败留下的待重置标记（超时 / 413 / 归档门 blocked）在下次进入时统一
      // 取出并归档重建（后台任务共用同一份会话映射）。取出只做取出：这三个分支原本都不打日志，
      // 这里也不打（文案差异留在 execute 那一侧，runPromptTurn 保持无声）。
      const pendingReset = takePendingReset(pendingResets, chatKey)
      if (pendingReset) resetChat(chatKey)
      const { sessionId } = await sessionForChat(chatKey)
      const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: String(text || '') }], source: { kind: 'qq-hub' } }
      try {
        // S2：与主链共用 chat/dsh-turn-runner.js 的事件机 —— collect.mode='prompt' 只留最后一条
        // 正文、忽略 tool/call、没有 steer 闸；signal 传 null（这条路本来就没有取消语义）。
        // 主动回合只生成文本、由调用方自行投递，这里不设报告标记（投递走的是调用方那一次 deliver）。
        const result = await turnRunner.runTurn({ sessionId, message, collect: { mode: 'prompt' }, signal: null })
        return result.text
      } catch (error) {
        // 与主链同款：413 / 请求体过大也要自愈（后台会话同样会攒图攒上下文）。
        // 主动任务没有人盯着看，notify=false：不往聊天里发提示（这轮本来就不投递）。
        if (error?.timedOut) handleTurnTimeout(chatKey, error.timedOutForMs, { notify: false })
        else if (!error?._turnFailureHandled && error?.oversized) handleOversizedTurn(chatKey, error.cause ?? error, { notify: false })
        // #263：blocked（归档门）同样要换会话，否则主动回合每轮都被拦（这条链原本没有自愈分支）。
        else if (!error?._turnFailureHandled && error?.archived) handleArchivedTurn(chatKey)
        // #263：上下文超窗在后台链只登记待重置（这条链不发回执）。
        else if (!error?._turnFailureHandled && classifyTurnFailure(error.cause ?? error).kind === 'context-window') {
          if (chatKey) markPendingReset(pendingResets, String(chatKey), 'context-window')
        }
        throw error
      }
    })
  }

  async function dispose() {
    for (const mounted of mountedTools.values()) {
      for (const off of mounted.offs) { try { off?.() } catch {} }
    }
    mountedTools.clear()
    lastInboundText.clear()
    pendingResets.clear()
    failureNoticedAt.clear()
    recentlyArchivedSessions.clear()
    sessionAdapter.clearTitles?.()
    await systemTurns.dispose()
    await registry.dispose()
    await controller.dispose()
    outbox.dispose()
    try { groups.dispose?.() } catch { /* 群刹车状态收尾失败不影响退出 */ }
  }

  // ---------- 模型同步（core/model-sync.js） ----------
  // 把面板选定的模型立刻应用到所有已有会话；失效会话连映射带人设账一起清。
  // registry / selectedModels / sessionPersonas 都是活引用（与回合主链同一份）。
  const modelSync = createModelSync({
    getConfig, log, registry, resolveTarget, applySessionModel, cleanupSession,
    ctxGet, sessionPersonas, selectedModels, chatViewFor, modelKey,
  })
  const { syncAllModels } = modelSync

  const services = {
    deliver: (chatId, text, opts) => replyDelivery.deliver(chatId, text, opts),
    // 道别后的主动开口静默期（conversation-closure 的 CLOSED + muteLockMs）。
    // 只锁主动搭话，不锁入站回复 —— speakup / purpose 据此少打扰一次。
    proactiveMuteState: (chatId, now) => replyDelivery.proactiveMuteState(chatId, now),
    isProactivelyMuted: (chatId, now) => replyDelivery.isProactivelyMuted(chatId, now),
    ...outbound,
    sendImage: (chatId, src, replyId, userId, opts) => outbound.sendImage(chatId, src, replyId, userId, { allowLocal: true, ...opts }),
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
    selfId: selfIdOf,
  }

  return {
    services,
    // 测试出口：装配主链本身。
    assemblyForTest: assembly,
    // 测试出口：回合失败分类与回执。
    // 只抛分类器（纯函数）和回执器，让回归能直接验证「403→moderation」「429→rate-limit」
    // 以及「群聊不发 / 私聊限频」这几条契约，不必真跑一轮模型。
    classifyTurnFailure,
    handleTurnFailure,
    dispatchLegacyEvent,
    dispatchLegacyEventSettled,
    runPromptTurn,
    runSystemTurn: (name, title, prompt, opts) => systemTurns.run(name, title, prompt, opts),
    syncAllModels,
    sessions,
    knownChats,
    resetSessions: resetAllSessions,
    sweepOrphanSessions,
    markTurnAt: (chatKey, now) => registry.markTurn(chatKey, now),
    chatKeyOfSession,
    isSystemSession: (sid) => systemSessionIds.has(String(sid || '')),
    isArchivingSession,
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
