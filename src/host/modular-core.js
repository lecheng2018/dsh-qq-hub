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
import { mkdirSync } from 'node:fs'

import { legacyEventToNormalized } from '../chat/adapters/legacy-inbound.js'
import { createDshSessionAdapter } from '../chat/adapters/dsh-session.js'
import { createOnebotOutboxAdapter, paramsFor } from '../chat/adapters/onebot-outbox.js'
import { createLegacyContextAdapter } from '../chat/adapters/legacy-context.js'
import { createSessionRegistry } from '../chat/session-registry.js'
import { createSessionFileStore } from '../chat/session-store.js'
import { createTurnController } from '../chat/turn-controller.js'
import { createContextAssembly } from '../chat/context-assembly.js'
import { createOutbox } from '../chat/outbox.js'
import { createDeliveryLedger } from '../chat/delivery-ledger.js'
import { isOwner, checkAllowed, levelFor, presetFor } from '../chat/access.js'
import { checkIdentityLeak } from '../chat/identity-guard.js'
import { parseMessageEvent } from '../chat/inbound.js'
import { parseCommand } from '../chat/commands.js'
import { mimeOf } from '../chat/inbound.js'
import { parseReply, replyRules } from '../chat/reply.js'
import { defaultModel, pickReasoningEffort } from '../core/llm.js'
import { resolveChatModel } from '../chat/chat-model.js'
import { workspaceDirOf, WORKSPACE_TITLE } from '../chat/hub.js'
import { createGroupState } from '../chat/group-state.js'
import { policyFor, decideGroupReply, topicRelevance } from '../chat/group-policy.js'
import { agoLabel } from '../chat/clockline.js'

/** 入站事件 → checkAllowed 需要的 msg 形状（从 ChatKey + sender 还原 kind/userId/groupId）。 */
function aclMsgFromInbound(inbound) {
  const chatKey = String(inbound?.chatKey ?? '')
  if (chatKey.startsWith('group:')) return { kind: 'group', userId: String(inbound?.sender?.userId ?? ''), groupId: chatKey.slice(6) }
  return { kind: 'private', userId: chatKey.slice(8), groupId: '' }
}

/** 段列表 → 纯文本（身份闸用；同 legacy sendSegments 的取词）。 */
function textOfSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter((s) => s && s.type === 'text')
    .map((s) => String(s?.data?.text || '')).join('')
}

/** 入站 → 模块中枢 activity 事件（等价 legacy hub.js:1583 那一发）。
 *  蒸馏/心情/token-guardian 等模块的 activity 计数全挂在这个事件上；开旗后消息不走 hub，
 *  不补这一发它们永远收不到计数（验收报告「额外缺口」，真机实测 L0 batches 恒 0）。 */
function emitActivity(mods, inbound) {
  try {
    const chatKey = String(inbound?.chatKey || '')
    if (!chatKey) return
    const kind = chatKey.startsWith('group:') ? 'group' : 'private'
    mods?.emit?.('activity', {
      kind: 'in',
      chatId: chatKey,
      userId: String(inbound?.sender?.userId || ''),
      nickname: String(inbound?.sender?.nickname || ''),
      text: textOfSegments(inbound.segments),
      // direct 语义对齐 legacy：私聊/被@ 才算（新核心暂无 @ 判定，群消息先记 false，不猜）
      direct: kind === 'private',
      owner: false, // owner 判定归消费方按配置算，这里不猜
    })
  } catch { /* 计数是旁路，绝不打断主链 */ }
}

/** 入站成员段 → DSH content 块（legacy 视图语义：文本段原样、图片段带 url/file、其余如实降级）。 */
function segmentsToContent(members) {
  const content = []
  for (const m of members) {
    for (const s of (m?.segments ?? [])) {
      if (s?.type === 'text') { const t = String(s.data?.text ?? ''); if (t) content.push({ type: 'text', text: t }) }
      else if (s?.type === 'image') content.push({ type: 'image', url: String(s.data?.url || s.data?.file || '') })
      else if (s?.type) content.push({ type: 'text', text: `\n[${s.type}]\n` }) // 语音/文件/转发/@：如实占位，不静默丢
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
 */
export function createModularCore({
  dsh, onebot, mods, getConfig, logger, log,
  personaText, runCommand, ledgerFile, sessionStoreFile,
  moodEffects, memoryScore, isMuted, interceptInteraction, personaTextFor,
}) {
  const debug = (m) => { try { log?.debug?.(m) } catch {} }

  // cordis 的 ctx.services / ctx.attachments / agent.ctx.contexts 都是「未声明 inject 直接点会抛」的
  // getter（真机报告 3/4：`cannot get property "…" without inject`，可选链 `?.` 挡不住 getter 求值）。
  // 一律走 ctx.get(...)（宿主已 inject 的服务名），拿到就 try/catch 兜住。
  const ctxGet = (name) => { try { return dsh?.get?.(name) ?? null } catch { return null } }
  const admitAttachments = () => { try { return dsh?.get?.('attachments') ?? null } catch { return null } }

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

  // ---------- 群回复闸（真机审计 §1）：复用 legacy 的纯函数与状态模块，不另起一套策略 ----------
  const groups = createGroupState()
  const pendingMode = new Map() // chatKey → 决定本轮的 mode（interject/engaged/must），execute 消费
  const moodChatty = () => {
    try {
      const m = typeof moodEffects === 'function' ? moodEffects() : null
      return m && typeof m.chatty === 'number' ? m.chatty : 1
    } catch { return 1 }
  }
  /** 群消息要不要回：与 hub.js:1424-1447 同一 decideGroupReply 调用形状。
   *  repliedToBot（引用她的消息）依赖引用解析（审计 1.5，挂账），暂按 false；不猜。 */
  function decideGroupReplyFor({ chatKey, text, mentioned, userId }) {
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
      repliedToBot: false,
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

  /** 图片段必须登记成 DSH 附件（attachmentId）。DSH 只认 base64 编码图片
   *  （`{ type:'image', data, mediaType }`），QQ 给的是 URL——所以先下载，再登记。
   *  下载/登记任一步失败就如实降级成一行文字（绝不把裸 url 图片块塞进历史，那会让整条会话永久失败）。 */
  async function admitContent(content) {
    if (!content.some((c) => c.type === 'image')) return content
    // 1) 裸 URL 的图片块 → 下载 + base64
    const hydrated = []
    for (const block of content) {
      if (block.type !== 'image' || block.data) { hydrated.push(block); continue }
      const url = String(block.url || '')
      try {
        if (!/^https?:\/\//i.test(url)) throw new Error('不是可下载的 http(s) 地址')
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        if (!buf.length) throw new Error('下载到 0 字节')
        if (buf.length > 10 * 1024 * 1024) throw new Error(`图片太大（${Math.round(buf.length / 1024)}KB）`)
        hydrated.push({ type: 'image', data: buf.toString('base64'), mediaType: mimeOf(buf), name: 'qq-image' })
      } catch (error) {
        debug(`图片下载失败，本轮按看不了图处理：${error?.message || error}`)
        hydrated.push({ type: 'text', text: '（对方发来一张图片，但本机没能把它下载下来，这轮看不到）' })
      }
    }
    if (!hydrated.some((c) => c.type === 'image')) return hydrated
    // 2) 交 DSH 登记成附件
    const att = admitAttachments()
    if (att && typeof att.admitPromptContent === 'function') {
      try { return await att.admitPromptContent(hydrated) } catch (error) {
        debug(`图片没登记成附件，本轮按看不了图处理：${error?.message || error}`)
      }
    }
    // 3) 降级：剥掉 image 块，保留文本 + 一行说明
    const text = hydrated.filter((c) => c.type !== 'image').map((c) => c.text ?? '').join('\n').trim()
    const note = '（对方发来一张图片，但本机没能把它登记成附件，本轮按看不到图处理）'
    return [{ type: 'text', text: `${text ? text + '\n' : ''}${note}` }]
  }

  // ---------- Session Registry（DSH 适配；preset 走 legacy levelFor/presetFor 语义） ----------
  const sessionAdapter = createDshSessionAdapter({
    dsh,
    // 会话标题（legacy hub.js titleFor 同语义，含真实群名）：新核心建完不命名，面板里全是「未命名」
    titleOf: async (chatKey) => {
      const cfg = getConfig()
      const owner = cfg.ownerName || '主人'
      if (String(chatKey).startsWith('group:')) return `QQ 群 · ${await groupNameOf(String(chatKey).slice(6))}`
      const uid = String(chatKey).slice(8)
      return uid === String(cfg.ownerQQ || '') ? `QQ · ${owner}私聊` : `QQ 私聊 · ${uid}`
    },
    // 会话必须带工作区，否则落到宿主 defaultCwd 直接 turn error（真机报告 5）；对齐 legacy ensureWorkspace
    ensureWorkspace: async () => {
      try {
        const reg = ctxGet('workspaceRegistry') ?? dsh?.workspaceRegistry
        if (!reg) return undefined
        const dir = workspaceDirOf(getConfig())
        try { mkdirSync(dir, { recursive: true }) } catch {}
        const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
        let ws = (reg.list?.() || []).find((w) => norm(w.path) === norm(dir))
        if (!ws && reg.create) ws = await reg.create(dir, WORKSPACE_TITLE)
        return ws
      } catch { return undefined }
    },
    presetOf: (chatKey) => {
      const cfg = getConfig()
      if (chatKey.startsWith('group:')) return { agentPreset: 'qq-hub-social' } // 群永远 ≤ social
      // 私聊：按主人/档位映射 preset（非主人白名单 = social，绝不再冒完整能力档）
      const level = levelFor(cfg, { kind: 'private', userId: chatKey.slice(8) })
      return { agentPreset: presetFor(level, cfg) }
    },
  })
  const sessionStore = sessionStoreFile ? createSessionFileStore({ file: sessionStoreFile }) : null
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
    createSession: sessionAdapter.createSession,
    ...(sessionStore ? { store: sessionStore } : {}),
    onError: (e) => log.warn('session 映射持久化异常：', e.message),
  })
  backfillTitles(registry)
  refreshGroupTitles(registry)

  // ---------- Context Assembly（模块上下文 + 人格） ----------
  const assembly = createContextAssembly({
    providers: [
      ...(personaText ? [{ moduleId: 'persona', priority: 1000, scope: 'global', cacheStable: true, provide: () => personaText() || '' }] : []),
      createLegacyContextAdapter({ mods, priority: 100 }),
    ],
  })

  // ---------- Outbox（唯一物理出口；授权/全局闸/身份闸/台账持久化全在此接线） ----------
  const ledger = ledgerFile ? createDeliveryLedger({ file: ledgerFile, onError: (e) => log.warn('投递台账落盘异常：', e.message) }) : undefined
  const outbox = createOutbox({
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
      return checkIdentityLeak(text, {
        surface: chatKey.startsWith('group:') ? '群消息' : '私聊消息',
        ids: [cfg.ownerQQ, cfg.botQQ].filter(Boolean),
        allowIds: [ownGroup, ...(chatKey.startsWith('private:') ? [cfg.ownerQQ] : [])].filter(Boolean),
        mode: ig.mode === 'warn' ? 'warn' : 'block',
      })
    },
  })

  // ---------- Turn Controller（执行 = 会话轮次 + 装配 + 投递） ----------
  /** 群聊上下文拼接（真机审计 1.3；legacy groupPrompt 的简化复刻）：
   *  未投喂最近 20 条 + 已投喂 8 条，带发言人标记与相对时间；主人只标「主人」不落号码。
   *  已知差异（挂账）：引用解析（1.5）与 <reply:n>/<at:>/图片说明出站（R4）未接，
   *  故不带这些指令文案，免得教她做不到的事。 */
  function groupPromptContent(chatKey, members) {
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
    const numbered = fresh.map((x, i) => `[${i + 1}] ${line(x)}`)
    const head = (older.length ? `【群聊 ${name}】之前在聊：\n${older.map(line).join('\n')}\n\n` : '') +
      `【群聊 ${name}】刚才新说的（${fresh.length} 条）${hint}\n${numbered.join('\n')}\n\n` +
      '把这一段当成整体来回：一般说一两句就好，回给最需要回的那个人或者整个话题，不要一条一条地挨个回。\n'
    // 触发轮自身的非文本段（图片等）照旧附上（走 admitContent 的登记/降级路线）
    const extras = []
    for (const m of members) for (const s of (m?.segments ?? [])) {
      if (s?.type === 'image') extras.push({ type: 'image', url: String(s.data?.url || s.data?.file || '') })
      else if (s?.type && s.type !== 'text') extras.push({ type: 'text', text: `\n[${s.type}]\n` })
    }
    return { blocks: [{ type: 'text', text: head }, ...extras], mode }
  }
  // 上下文/人设挂载：agent 级一次性注册（legacy mount 同型），text 闭包每轮读最新
  const ctxBoxes = new WeakMap()
  const personaVarSet = new WeakSet()
  const controller = createTurnController({
    log,
    merge: {
      waitMs: Number(getConfig().merge?.waitSec * 1000) || 2500,
      maxMs: Number(getConfig().merge?.maxSec * 1000) || 8000,
      groupWaitMs: Number(getConfig().merge?.groupWaitSec * 1000) || 5000,
      groupMaxMs: Number(getConfig().merge?.groupMaxSec * 1000) || 15000,
    },
    execute: async (turn, io) => {
      const chat = chatViewFor(turn.chatKey, io.members)
      const inGroup = chat.kind === 'group'
      // 1. 装配上下文（persona + 模块 provider；chat 视图透传给 legacy provider 契约）
      const sessionId0 = registry.peek(turn.chatKey)?.sessionId
      const { fragments } = await assembly.assemble({ chatKey: turn.chatKey, sessionId: sessionId0, chat })
      // 2. 会话（single-flight 创建在 offer 时已发生；这里拿映射）
      const { sessionId } = await registry.sessionFor(turn.chatKey)
      // 3. 构造会话消息：群聊带整段缓冲上下文（真机审计 1.3），私聊用触发段本体
      let turnMode = null
      let content
      if (inGroup) {
        const gp = groupPromptContent(turn.chatKey, io.members)
        content = gp.blocks
        turnMode = gp.mode
      } else {
        content = segmentsToContent(io.members)
      }
      const ctxText = fragments.map((f) => f.content).join('\n')
      // 4. 驱动 DSH 会话轮次（resolveAgent → followup；steer 输入注册给后续转向）
      //    sessionController 只能走 ctx.get（真机报告 3：cordis 未声明 inject 的 .services 直接点会抛）
      const ctrl = ctxGet('sessionController')
      if (!ctrl?.resolveAgent) throw new Error('DSH 没有 sessionController（新核心无法驱动会话）')
      const resolved = await ctrl.resolveAgent(sessionId)
      const agent = resolved?.agent
      if (!agent?.followup) throw new Error(`会话 ${sessionId} 没有 agent.followup（适配缺口，如实失败）`)

      // 4.5 模型跟随面板配置（真机报告 8）：不切的话会话会跑 DSH 默认模型——
      //     风格/成本不一致，纯文本模型还会连带把看图堵死。与 legacy applyModel 同款：
      //     只改本会话下一请求（selectForNextRequest），绝不动 DSH 全局默认。
      try {
        const cfgNow = getConfig()
        let sel = null
        const t0 = defaultModel(dsh, cfgNow)
        if (t0) sel = { provider: t0.provider, model: t0.model, reasoningEffort: cfgNow.model?.reasoningEffort || '' }
        const t1 = resolveChatModel(cfgNow, chat, null) // 主人按聊天指定的优先
        if (t1) sel = { provider: t1.provider, model: t1.model, reasoningEffort: t1.reasoningEffort || cfgNow.model?.reasoningEffort || '' }
        if (sel?.provider && sel?.model) {
          const target = { provider: sel.provider, model: sel.model }
          const effort = await pickReasoningEffort(dsh, target.provider, target.model, sel.reasoningEffort || undefined)
          if (effort) target.reasoningEffort = effort
          const selFn = ctrl.agents?.selectForNextRequest
          if (typeof selFn === 'function') selFn.call(ctrl.agents, agent, target)
          else if (typeof agent?.session?.append === 'function') agent.session.append('model/selection', target)
        }
      } catch (error) { debug(`模型选择未生效（用默认）：${error.message}`) }

      // 4.6 上下文与人设挂载（真机审计 1.1 第一层 + 1.2）：legacy 的 seam 是
      //     agent.ctx.systemPrompt.context()/variable()（hub.js:546/529）——宿主上
      //     `agent.ctx.get('contexts')` 取不到服务，此前投喂因此整段丢弃。改回同款通道，
      //     每个 agent 只注册一次，text 闭包每轮读最新（面板改动下一轮生效，同 legacy）。
      try {
        const sp = agent.ctx?.systemPrompt
        if (sp?.context) {
          let holder = ctxBoxes.get(agent)
          if (!holder) { holder = { text: ctxText }; ctxBoxes.set(agent, holder); sp.context({ name: 'qq-hub-context', order: 905, text: () => holder.text }) }
          else holder.text = ctxText
        } else debug('宿主没有 systemPrompt.context 通道，本轮模块上下文只随装配产出留档（如实记录）')
        if (typeof personaTextFor === 'function' && sp?.variable && !personaVarSet.has(agent)) {
          personaVarSet.add(agent)
          sp.variable('qq_hub_persona', () => {
            try { const t = personaTextFor(chat); if (t) return t } catch {}
            try { return personaText ? personaText() : '' } catch { return '' }
          })
        }
      } catch (error) { try { log?.warn?.('上下文/人设挂载失败（本轮照跑）：', error.message) } catch {} }

      // 5. 等**回合结束**（不是首个 assistant/message）：
      //    - assistant/message：跳过 interrupted 的部分内容，记下本 turn 文本（可能多条取最后）；
      //    - turn/end：completed 且有文本才 resolve；非 completed 如实失败（不发、释放调度槽）；
      //    - followup rejection：捕获，回合落定异常，finally 清理监听器（防句柄泄漏）。
      let off = null
      const cleanupListener = () => { try { off?.() } catch {} off = null }
      const replyPromise = new Promise((resolve, reject) => {
        let lastTurn = null
        let lastText = ''
        off = dsh.on?.('session/event', (session, ev) => {
          if (session?.id !== sessionId) return
          if (ev?.type === 'assistant/message') {
            const d = ev?.data || {}
            if (d.interrupted) return
            const t = (d.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
            if (t) { lastTurn = d.turn; lastText = t }
            return
          }
          if (ev?.type === 'turn/end') {
            const d = ev?.data || {}
            const completed = d.reason && d.reason.kind === 'completed'
            const text = lastTurn === d.turn ? lastText : ''
            cleanupListener()
            if (!completed) { reject(new Error(`回合未正常结束：${d.reason?.kind || '?'}`)); return }
            resolve(String(text ?? ''))
          }
        })
        if (typeof off !== 'function') {
          // 无事件流的 DSH：followup 链落定后取不到回复文本（如实报错，不猜）
          cleanupListener()
          reject(new Error('DSH 没有 session/event 流，无法取回复文本'))
        }
      })
      // 5.5 消息完整形状（真机报告 1：DSH agent-loop 的 isOwned(message) 读 message.source.kind，
      //     只传 {content} 会在 turn/start 后 8ms 以 error 结束）。对齐 legacy hub.js:1902。
      const admitted = await admitContent(content)
      const message = { id: randomUUID(), role: 'user', content: admitted, source: { kind: 'qq-hub' } }
      // followup 的 rejected promise 必须捕获：否则 unhandledRejection + 回合永久 running 占死该聊天调度槽
      let followupError = null
      try {
        await agent.followup(message)
      } catch (error) {
        followupError = error
      }
      if (followupError) {
        cleanupListener() // 失败路径同样摘监听（报告 §4.5「finally 清理监听」）
        throw new Error(`DSH 回合执行失败：${followupError?.message || followupError}`)
      }
      let reply
      try {
        reply = await replyPromise
      } catch (error) {
        cleanupListener() // turn/end 非 completed / 无事件流：摘除后如实失败（回合落 failed，槽释放）
        throw error
      }

      // 6. 出站后处理（真机报告 6：不处理后处理链时 `|||` 字面外发）：
      //    stripReasoning、按 ||| 分气泡（maxBubbles 上限由 replyRules 收敛）、[沉默] 不说话——与 legacy 同一函数。
      if (!reply) return null
      const cfgOut = getConfig()
      const parsed = parseReply(reply, replyRules(cfgOut, turn.chatKey.startsWith('group:')))
      if (parsed.silent) return null
      const bubbles = parsed.items.filter((i) => i.kind === 'text')
      const skipped = parsed.items.length - bubbles.length
      if (skipped > 0) debug(`本轮 ${skipped} 个富媒体/引用标记未接线（R4 已知缺口），只发文字气泡`)
      // 7. 回复经 outbox 投递（唯一物理出口；多气泡按序多条 request，FIFO 保证顺序）
      let result = null
      for (const b of bubbles) {
        result = await outbox.request({
          chatKey: turn.chatKey,
          turnId: turn.turnId,
          sourceModuleId: 'core',
          segments: [{ type: 'text', data: { text: b.value } }],
        })
      }
      // 8. 群说话记账（legacy noteSpeak/noteInterject 同款）：刹车（burst 上限）与冷却的数据源
      if (inGroup && result && (result.state === 'sent' || result.state === 'unknown')) {
        const gid = chat.groupId
        try { groups.noteSpokeInGroup(gid) } catch {}
        try { if (turnMode === 'interject') groups.noteInterject(gid) } catch {}
      }
      return result
    },
  })

  /** 聊天域消息入口（host dispatchEvent 的旗开分支）。 */
  async function dispatchLegacyEvent(ev) {
    const cfg = getConfig()
    // 命令闸（M4-2）：主人斜杠命令先截，回复经 outbox（同 legacy：命令不进合流，总开关关着也处理）
    if (runCommand && ev.post_type === 'message') {
      const view = parseMessageEvent(ev, ev.self_id)
      const cmd = parseCommand(view.text, mods.commands())
      if (cmd && !cmd.ext && isOwner(cfg, view.userId)) {
        const reply = await runCommand(cmd, { ...view, chatId: view.chatId, nickname: cfg.ownerName || '主人', text: view.text })
        if (reply) {
          await outbox.request({
            chatKey: view.chatId,
            sourceModuleId: 'core',
            segments: [{ type: 'text', data: { text: String(reply) } }],
            dryRun: cfg.dryRun === true,
          })
          return { handled: 'command' }
        }
      }
    }
    const { inbound } = safeAdapt(ev, 'realtime')
    if (!inbound) return { handled: 'skipped' }
    return routeInbound(inbound, ev, 'realtime')
  }

  /**
   * 入站主链（realtime/backfill 共用），顺序逐项对齐 legacy hub.onMessage：
   * ACL → 旁路指令 → 总开关 → 静音 → 群缓冲 → activity 计数 → 群回复闸 → offer。
   * （真机审计 1.9/1.10/§1：enabled=false 和静音必须**入口就拦**——不进回合不烧 token；
   *  activity 在闸之前发：蒸馏等模块的计数不受「要不要回」影响。）
   */
  function routeInbound(inbound, ev, source) {
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
    const inGroup = inbound.chatKey.startsWith('group:')
    const text = textOfSegments(inbound.segments)
    const userId = String(inbound?.sender?.userId ?? '')
    // 群缓冲（legacy 同款：群里的每条消息都记，给上下文和「群里在不在聊」用；ACL 后、闸前）
    let mentioned = false
    if (inGroup) {
      try {
        mentioned = !!parseMessageEvent(ev, ev.self_id).mentioned
      } catch {}
      const gid = inbound.chatKey.slice(6)
      groups.appendMessage(gid, { t: Date.now(), uid: userId, nick: String(inbound?.sender?.nickname || ''), text, at: mentioned, mid: String(inbound.messageId || ''), direct: false })
    }
    emitActivity(mods, inbound)
    if (inGroup) {
      const decision = decideGroupReplyFor({ chatKey: inbound.chatKey, text, mentioned, userId })
      if (!decision.reply) {
        debug(`群闸 ${inbound.chatKey}：不回 —— ${decision.reason}`)
        return { handled: 'group-pass', reason: decision.reason }
      }
      if (decision.mode) pendingMode.set(inbound.chatKey, decision.mode)
    }
    controller.offer(inbound)
    return { handled: 'offered' }
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
  function dispatchBackfill(ev) {
    const { inbound } = safeAdapt(ev, 'backfill')
    if (!inbound) return { handled: 'skipped' }
    return routeInbound(inbound, ev, 'backfill')
  }

  async function dispose() {
    await registry.dispose()
    await controller.dispose()
    outbox.dispose()
  }

  return {
    dispatchLegacyEvent,
    dispatchBackfill,
    outbox,
    registry,
    controller,
    dispose,
    stats: () => ({ sessions: Object.keys(registry.snapshot()).length }),
  }
}
