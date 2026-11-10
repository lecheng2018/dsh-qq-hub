// 消息中枢：QQ 会话 ↔ DSH 会话。
//   收：OneBot 事件 → 白名单 / 群聊策略 → 拼好文案（带发言人、群上下文、图片、语音转写）→ 喂进对应 DSH 会话
//   发：DSH 会话一轮结束 → 取最终正文 → 拆条 / 语音 / 表情 → 发回原来的 QQ 会话
// 每个 QQ 会话一个 DSH 会话，统一放在「QQ Hub」工作区，主人可以在 DSH 侧栏点开看、插手。

import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { parseMessageEvent } from './inbound.js'
import { parseReply, bubbleDelay, wantsVoice, replyRules } from './reply.js'
import { createInteractionState } from './interaction-state.js'
import { createGroupState } from './group-state.js'
import { createActivityState } from './activity-state.js'
import { nowLine, agoLabel } from './clockline.js'
import { checkIdentityLeak } from './identity-guard.js'
import { createGroupQuota } from './group-quota.js'
import { assessFishDensity, assessPairLoop, dedupConvo, fishGuardReasonText, normalizeFishGuard, senderFish } from './fish-guard.js'
import { decideGroupReply, policyFor, topicRelevance } from './group-policy.js'
import { checkAllowed, levelFor, presetFor, isOwner } from './access.js'
import { fetchImage, segmentBytes } from '../core/net.js'
import { toMono16k } from '../voice/wav.js'
import { mimeOf } from './inbound.js'
import { redact } from '../core/redact.js'
import { defaultModel, pickReasoningEffort, canSeeImages, modelVision, describeWithHelper } from '../core/llm.js'
import { resolveChatModel } from './chat-model.js'
import { createFaces, textToSegments, stripFaceTags, speakableText, dedupeFaces } from './faces.js'
import { expandMentions, hasMention } from './mentions.js'
import { createRecentMedia } from './recent-media.js'
import { createQuestionRegistry } from './questions.js'
import { createApprovalRegistry } from './approvals.js'
import { personaIdFor, readPersona } from '../persona/personas.js'
import { backfillNoticeBlock } from './backfill.js'
import { readInboundFiles, inboundFileBlocks } from './inbound-files.js'

// QQ 会话的工作区目录，第一次收到消息时自动创建。面板「连接」页能改（config.workspaceDir，#32）；
// 没填就用环境变量 AURABOT_WORKSPACE，再没有：老安装沿用 C:\Aurabot\qq-chats，新安装放在用户目录下（不用往 C 盘根目录写）
const LEGACY_WORKSPACE = 'C:\\Aurabot\\qq-chats'
export const WORKSPACE_DIR = process.env.QQ_HUB_WORKSPACE || process.env.AURABOT_WORKSPACE || (existsSync(LEGACY_WORKSPACE) ? LEGACY_WORKSPACE : join(homedir(), 'Aurabot', 'qq-chats'))
/** 现在用的工作区目录：面板里填了就用填的，否则默认。 */
export const workspaceDirOf = (cfg) => String(cfg?.workspaceDir || '').trim() || WORKSPACE_DIR
export const WORKSPACE_TITLE = 'QQ Hub'
const SOURCE_KIND = 'qq-hub'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sessionKey = (id) => {
  const s = String(id ?? '')
  return s.startsWith('session-') ? s.slice(8) : s
}

/**
 * hooks（扩展模块用，都可以不传）：
 *   message(msg) → true 表示这条消息被模块接管了，她不再处理
 *   persona(text) → 改写人设正文（全局那份和按聊天换的专用卡都走这里）
 *   reply(text, {chatId}) → 改写她要发的话；返回 null 表示这次不发
 *   deniedTools() → 不许出现在她 QQ 会话里的全局工具名（给其他 DSH 会话用的联动工具）
 *   groupDecide(decision, info) → 改群聊「回不回、怎么回」的决定 { reply, mode, reason }
 *   prompt(content, info) → 改交给她的内容（文字 / 图片块）；返回 null 表示这次不交给她
 *   items(items, info) → 改拆好的回复（每条 { kind: text|voice|sticker|poke|image, value, replyTo }）
 *   send(message, info) → 改最终发出去的 OneBot 消息段；返回 null 表示不发
 *   model(selection, chat) → 这个聊天用哪个模型 { provider, model, reasoningEffort }（同步）；selection 已经按主人「按聊天选模型」的设置算过
 *   poke(event) → true 表示戳一戳被模块接管了
 */
// 模拟测试：这里面发出去的消息只记下来，不真发
const captureStore = new AsyncLocalStorage()
export function createHub({ dsh, getConfig, log, onebot, stickers, tts, buildTools, contextProviders, onActivity, memoryScore, onCommand, isMuted, moodEffects, localApi, hooks, availableModels, toolsGeneration, egressRef, resolveChatOfSession }) {
  // 心情对行为的影响（表情 / 语音概率、回复快慢、插话积极程度），没接就是 1
  const mood = () => (typeof moodEffects === 'function' ? moodEffects() : null) || { sticker: 1, voice: 1, delay: 1, chatty: 1 }
  const mapFile = () => dataDir('sessions.json')
  const map = () => readJson(mapFile(), () => ({ chats: {} }))
  const saveMap = (m) => writeJson(mapFile(), m)

  const mounted = new Map() // sessionKey → { agent, offs, chatId, toolsKey }  按会话记，agent 对象换了也能清掉旧工具（#90）
  // chatId → 上一次把消息交给她是什么时候。存进 sessions.json（lastTurnAt），重启之后
  // 「距上一条消息 2 小时」照样算得出来；内存里再留一份，会话刚建、entry 还没落盘时也不丢。
  const lastTurnAt = new Map()
  const toolDisposers = new Map() // `${sessionKey}|${工具名}` → disposer，防注册表里残留同名工具时挂不上（#90）
  const sessionToChat = new Map() // sessionKey → chatId
  // pair 对聊冷却表（1.3.63）：`群号:uid` → 冷却截止时间；懒清理（写时扫掉过期项）
  const pairCalmUntil = new Map()
  const pairCalmSweep = (nowTs) => {
    if (pairCalmUntil.size < 50) return
    for (const [k, v] of pairCalmUntil) if (v < nowTs - 3 * 3600_000) pairCalmUntil.delete(k)
  }
  const turnState = new Map() // sessionKey → { lastTurn, text, images, senders:Set, system?: {resolve, reject} }
  // 群聊状态（1.3.57）：消息缓冲 / 引用编号表 / 话题加入 / 说话与插话时间 / 群名与群成员缓存。
  // 七个 groupId 键的 Map 收进 group-state.js，规则（40 条上限、1 小时窗口、3 分钟话题）各归其位。
  const groups = createGroupState()
  // 兼容：外部模块（features/memory.js）按 hub.groupNames.get?.() 取群名
  const groupNames = groups.names
  const quoteCache = new Map() // replyId → { ok, who, uid, text, images, stickers, records, isBot }  引用消息解析缓存
  // chatId → 这一轮是否调过内容型工具（报告兜底用，turn/end 清掉）。见 CONTENT_TOOLS。
  const reportTurns = new Map()
  // 内容型工具清单（报告兜底第二层）：这些工具的产物是「给主人看的数据」，回复应该整段排版。
  // 记忆型（recall_memory、qq_chat_history）和管理型（qq_group_admin 等）刻意不在列。
  // 新增内容型工具时在这里加一行；她写了 <report> 标记时第一层优先生效，这里只是兜底。
  const CONTENT_TOOLS = /^(rss_read|bili_watch|heybox_(feed|watch|hot)|douyin_(watch|recent|browse)|qq_draw_image|qq_song_cover)$/

  const recentMedia = createRecentMedia({ log }) // 最近发来的图片和表情，短期落盘恢复
  // 「她挑 / 只听主人的」：这一轮收到的表情先按会话记着，她想收时凭编号来取。
  // 落盘存一份 —— 只在内存里的话，DSH 一重启就什么都没有了，她只好绕路（拷附件 + qq_add_sticker）。
  const stickerStash = new Map() // chatId → { at, segs: [seg] }
  // 互动状态（1.3.57）：小黄脸去重池 / 谁戳过她 / 谁最后说话 / 戳一戳节流 / 别处代发的补话队列。
  // 从 hub 的 23 个 Map 里剥出来的第一批——都是纯内存、纯 chatId 键，规则收进 interaction-state.js。
  const interaction = createInteractionState()
  const STICKER_TTL = 30 * 60_000 // 和「最近图片」一个尺度
  const stashFile = () => dataDir('sticker-stash.json')
  let stashLoaded = false

  // 交互式提问（User Questions）与通用工具审批（Approvals）
  const questions = createQuestionRegistry({
    deliver: (chatId, text) => sendText(chatId, text, undefined, [], undefined),
    timeoutMs: Number(getConfig().questions?.timeoutMs) || 300_000,
    log: log.child ? log.child('questions') : log
  })

  const approvals = createApprovalRegistry({
    deliver: (chatId, text) => sendText(chatId, text, undefined, [], undefined),
    ownerQQ: () => getConfig().ownerQQ,
    // security-lock 模块已移除：不传锁，approvals 的锁分支自然不会触发
    timeoutMs: Number(getConfig().admin?.approvalTimeoutMs) || 60_000,
    log: log.child ? log.child('approvals') : log
  })

  function loadStash () {
    if (stashLoaded) return
    stashLoaded = true
    try {
      const raw = readJson(stashFile(), () => ({}))
      const now = Date.now()
      for (const [chatId, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
        if (v && Array.isArray(v.segs) && v.segs.length && now - Number(v.at || 0) < STICKER_TTL) {
          stickerStash.set(chatId, { at: Number(v.at) || now, segs: v.segs })
        }
      }
    } catch (error) {}
  }

  function saveStash () {
    const now = Date.now()
    const out = {}
    for (const [chatId, v] of stickerStash) if (v && now - v.at < STICKER_TTL) out[chatId] = v
    try { writeJson(stashFile(), out) } catch (error) {}
  }

  /** 记下这一轮收到的表情，返回张数。 */
  function rememberStickers (chatId, segs) {
    loadStash()
    const list = (segs || []).slice(0, 4)
    if (!list.length) return 0
    stickerStash.set(chatId, { at: Date.now(), segs: list })
    saveStash()
    return list.length
  }

  /** 取第 index 张（从 1 开始）。过期或没有就返回 null。 */
  function stickerOf (chatId, index) {
    loadStash()
    const s = stickerStash.get(chatId)
    if (!s || Date.now() - s.at > STICKER_TTL) return null
    const i = Number(index) - 1
    return Number.isInteger(i) && i >= 0 && i < s.segs.length ? s.segs[i] : null
  }

  /**
   * 「她挑」模式那句轻提示。
   * 措辞要像她自己的念头，不能像发图的人在提醒她 —— 否则每来一张表情她就回报一次
   * “我收了 / 我已经有了”，完全不像偷偷攒表情。收不收、说不说都随她。
   */
  function stickerHint (n) {
    const range = n > 1 ? `1~${n}` : '1'
    return `（这轮里夹着 ${n} 张表情，是你自己看到的。有中意的就用 qq_collect_sticker ${range} 收进自己库；收表情是你自己的小爱好，不用每张都跟对方说，偶尔提一句也行。）`
  }

  const slowNoticeSent = new Set() // sessionKey → 这一轮已经发过「正在做」提示（慢工具，issue #74）
  const faces = createFaces({ onebot, log }) // QQ 系统表情：<face:名字> ↔ 编号

  async function membersOf(groupId) {
    const hit = groups.cachedMembers(groupId)
    if (hit) return hit
    try {
      const r = await onebot.call('get_group_member_list', { group_id: Number(groupId) }, { timeoutMs: 15000 })
      const list = Array.isArray(r) ? r : r?.data || []
      groups.setMembers(groupId, list)
      return list
    } catch (error) {
      log.debug('拉群成员失败，@ 按文字发：', error.message)
      return groups.staleMembers(groupId)
    }
  }
  const sentIds = new Set()
  // 每个聊天上一条回复用过的系统表情：同一条/相邻条别重复用（实测她老配 OK/得意）
  // 群发送配额：QQ 群每分钟最多 10 条，超了网关直接拒、消息真丢（2026-11-04 实测 3 条丢 2 条）
  const groupQuota = createGroupQuota({ getConfig, log })
  void groupQuota
  const stats = { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day: new Date().toDateString() }
  let selfId = ''
  let lastChatAt = 0
  let lastOwnerChatAt = 0
  let lastBotToOwner = { at: 0, text: '' } // 她在主人私聊里最后说的话

  function bump(k) {
    const d = new Date().toDateString()
    if (stats.day !== d) Object.assign(stats, { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day: d })
    stats[k]++
  }

  // ---------- 聊天流水（给空间日记、主动搭话、面板用） ----------
  function logChat(chatId, who, text, uid = '') {
    try {
      const d = new Date()
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const dir = dataDir('chatlog')
      mkdirSync(dir, { recursive: true })
      const cfg = getConfig() || {}
      const uidText = String(uid || '')
      const ownerName = uidText && uidText === String(cfg.ownerQQ || '') ? String(cfg.ownerName || '主人') : ''
      const author = String(who || '').trim() || ownerName || uidText || (String(chatId).startsWith('private:') ? String(chatId).slice(8) : '群成员')
      appendFileSync(join(dir, `${day}.jsonl`), JSON.stringify({ t: Date.now(), chatId, who: author, ...(uid ? { uid: uidText } : {}), text: redact(String(text).slice(0, 500)) }) + '\n', 'utf8')
    } catch (error) {}
  }

  /** 有聊天流水的日期（升序）。 */
  /**
   * 记下「这一次交给她」的时间，返回上一次的时间（没有就是 0）。
   * 时间锚用：她知道这次隔了多久，也知道「两小时前那句叫你睡觉」是两小时前的。
   */
  function markTurnAt (chatId, now = Date.now()) {
    const m = map()
    const e = m.chats[chatId]
    const last = Number(e?.lastTurnAt) > 0 ? Number(e.lastTurnAt) : (lastTurnAt.get(chatId) || 0)
    lastTurnAt.set(chatId, now)
    if (e) { e.lastTurnAt = now; saveMap(m) }
    return last
  }

  function chatLogDays() {
    try {
      return readdirSync(dataDir('chatlog')).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort()
    } catch (error) {
      return []
    }
  }

  function deleteChatLog(day) {
    try { unlinkSync(join(dataDir('chatlog'), `${day}.jsonl`)) } catch (error) {}
  }

  function chatLogOf(day) {
    try {
      const f = join(dataDir('chatlog'), `${day}.jsonl`)
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch (error) {
      return []
    }
  }

  // ---------- 工作区与会话 ----------
  // 每个聊天一个子工作区：DSH 的灵魂记忆（dsh-soul）按会话 cwd 聚合（projectScope = hash(cwd)），
  // 所有聊天共用一个工作区时，灵魂库会把 A 群的「上次会话摘要」注入进 B 群（跨群串台，实测：
  // 赛博鸡蛋群的「鲸叫」梗进了另一个群的开场白）。子目录在主工作区内部，发文件白名单不受影响。
  const CHAT_WS_PREFIX = 'chat-'
  function chatWorkspaceDir(chatId) {
    const root = workspaceDirOf(getConfig())
    const safe = String(chatId || '').replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(root, CHAT_WS_PREFIX + safe)
  }
  async function ensureWorkspace(chat) {
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    if (!reg) throw new Error('宿主没有 workspaceRegistry')
    // 默认所有 QQ 会话共用同一个工作区。
    // 1.3.33 曾按 chatId 给每个聊天建子工作区，本意是让 dsh-soul 的 project scope 按聊天隔离；
    // 但那样每个群 / 每个私聊都会在宿主里多出一个工作区，聊得越多列表越脏（2026-11-05 实测）。
    // 跨聊天串台的源头是 dsh-soul 的 project 级 handoff，那个已经停用；
    // 群聊和陌生人会话本来就没有文件工具，共用工作区不会互相看见文件。
    // 需要时可以在配置里打开 workspacePerChat 恢复按聊天隔离。
    const perChat = chat?.chatId && !chat.chatId.startsWith('system:') && getConfig().workspacePerChat === true
    const dir = perChat ? chatWorkspaceDir(chat.chatId) : workspaceDirOf(getConfig())
    mkdirSync(dir, { recursive: true })
    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
    let ws = reg.list().find((w) => norm(w.path) === norm(dir))
    if (!ws) {
      ws = await reg.create(dir, WORKSPACE_TITLE)
      log.info('建好了工作区「' + WORKSPACE_TITLE + '」：' + dir)
    }
    return ws
  }

  function controller() {
    const c = dsh.get('sessionController')
    if (!c) throw new Error('宿主没有 sessionController（需要 DSH 桌面版 / Web 组合）')
    return c
  }

  /**
   * 面板用：列出「机器人见过的聊天」，让人直接选，不用手打群号/QQ 号。
   * 来源是 sessions.json（每个真正聊过的会话都会记一条），群名优先用 groupNames 里的最新值。
   * chatId 形如 private:123 / group:456。只读，不改任何状态。
   */
  function knownChats () {
    const out = []
    try {
      for (const [chatId, e] of Object.entries(map().chats || {})) {
        const [kind, id] = String(chatId).split(':')
        if (kind !== 'private' && kind !== 'group') continue
        let name = e.title || chatId
        if (kind === 'group' && groupNames.get(id)) name = 'QQ 群 · ' + groupNames.get(id)
        out.push({ chatId, kind, id, name, lastAt: e.createdAt || 0 })
      }
    } catch (error) {
      log.debug('读聊天列表失败：', error.message)
    }
    return out.sort((a, b) => b.lastAt - a.lastAt)
  }

  function titleFor(chat) {
    const owner = getConfig().ownerName || '主人'
    if (chat.kind === 'system') return `QQ · ${chat.title || '后台'}`
    if (chat.kind === 'group') return `QQ 群 · ${groupNames.get(chat.groupId) || chat.groupId}`
    return chat.userId === getConfig().ownerQQ ? `QQ · ${owner}私聊` : `QQ 私聊 · ${chat.nickname || chat.userId}`
  }

  async function createSession(chat, level) {
    const ws = await ensureWorkspace(chat)
    const preset = presetFor(level, getConfig())
    const r = await controller().create({ workspaceId: ws.id, agentPreset: preset })
    const sid = String(r.sessionId)
    try {
      await controller().rename({ sessionId: sid, title: titleFor(chat) })
    } catch (error) {
      log.debug('改会话标题失败：', error.message)
    }
    // 记下建会话时生效的人设：切人设后旧历史里还躺着旧人设块，模型逐条仲裁思考暴涨，
    // 所以 personaId 变了就整个换会话（见 agentFor）。
    const m = map()
    m.chats[chat.chatId] = { sessionId: sid, preset, level, personaId: personaIdFor(chat, getConfig()), createdAt: Date.now(), title: titleFor(chat) }
    saveMap(m)
    log.info(`为 ${chat.chatId} 新建了 DSH 会话 ${sid.slice(-8)}（${preset}）`)
    return sid
  }

  async function resolveAgent(sid) {
    const live = dsh.agents.get(sid) || dsh.agents.get('session-' + sid)
    if (live) return live
    const r = await controller().resolveAgent(sid)
    if (r && r.agent) return r.agent
    const e = r && r.error
    throw Object.assign(new Error(e?.message || '恢复会话失败'), { code: e?.code })
  }

  /** 拿到这个 QQ 会话对应的活 agent（没有就建，权限档位变了就换新会话）。 */
  async function agentFor(chat) {
    const cfg = getConfig()
    const level = chat.kind === 'system' ? (chat.noTools ? 'chat' : 'social') : levelFor(cfg, chat)
    const preset = presetFor(level, cfg)
    let entry = map().chats[chat.chatId]
    // 人设变了（面板里切了本聊天专用人设/全局人设）也换新会话：旧历史里的人设块清不掉，
    // 留着会让模型逐条仲裁新旧人设。entry 没记 personaId 的老会话只补记基线不重置
    //（没法知道它当年用的哪张卡，乱重置会误伤没换过人设的群）。
    const wantPersona = personaIdFor(chat, cfg)
    if (entry && !entry.personaId && wantPersona) {
      entry.personaId = wantPersona
    }
    if (entry && entry.personaId && entry.personaId !== wantPersona) {
      log.info(`${chat.chatId} 的人设从 ${entry.personaId} 切到 ${wantPersona}，开新会话`)
      resetChat(chat.chatId)
      entry = null
    }
    let sid = entry && entry.preset === preset && entry.level === level
      && (!entry.personaId || entry.personaId === wantPersona) ? entry.sessionId : ''
    let agent = null
    if (sid) {
      try {
        agent = await resolveAgent(sid)
      } catch (error) {
        log.warn(`会话 ${sid.slice(-8)} 恢复不了（${error.message}），换一个新的`)
        sid = ''
      }
      const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
      if (sid && reg && (reg.archivedSessionIds || []).includes(sid)) {
        log.info(`会话 ${sid.slice(-8)} 被归档了，换一个新的`)
        sid = ''
        agent = null
      }
    }
    if (!sid) {
      sid = await createSession(chat, level)
      agent = await resolveAgent(sid)
    }
    // 模型 / 思考强度和设置不一致就切过去（面板改了模型，下一条消息起生效）
    const target = await resolveTarget(chat)
    const want = keyOf(target)
    const m = map()
    if (want && m.chats[chat.chatId] && m.chats[chat.chatId].model !== want) {
      if (applyModel(agent, target)) {
        m.chats[chat.chatId].model = want
        saveMap(m)
        log.info(`${chat.chatId} 的模型切到 ${want}`)
      }
    }
    sessionToChat.set(sessionKey(sid), chat.chatId)
    mount(agent, chat, level)
    return { agent, sessionId: sid, level }
  }

  /** 这个聊天要用的模型：主人按聊天指定的 > 面板里选的全局模型（或 DSH 默认），扩展模块还可以再按聊天改。 */
  function targetModel(chat) {
    const cfg = getConfig()
    const t = defaultModel(dsh, cfg)
    let sel = t ? { provider: t.provider, model: t.model, reasoningEffort: cfg.model.reasoningEffort || '' } : null
    // 主人按聊天指定的模型（私聊 QQ 号 > 群号 > 所有私聊 / 所有群默认）；没指定或指定的模型已不存在就用上面的
    try {
      const r = resolveChatModel(cfg, chat, typeof availableModels === 'function' ? availableModels() : null)
      if (r) sel = { provider: r.provider, model: r.model, reasoningEffort: r.reasoningEffort || cfg.model.reasoningEffort || '' }
    } catch (error) {}
    if (hooks?.model && chat) {
      try {
        const r = hooks.model(sel, chat)
        if (r && r.provider && r.model) sel = { reasoningEffort: '', ...r }
      } catch (error) {}
    }
    return sel
  }
  /**
   * 想要的思考强度要先按模型能力收敛：没有推理元数据的模型（本地 Ollama、部分手写 provider）
   * 只要收到 reasoningEffort 就会被 DSH 整轮拒掉（UNSUPPORTED_REASONING_EFFORT），
   * 等于这个模型直接没法用。不支持就不传这个参数，让 DSH 用模型自己的默认。
   */
  async function resolveTarget(chat) {
    const t = targetModel(chat)
    if (!t) return null
    const effort = await pickReasoningEffort(dsh, t.provider, t.model, t.reasoningEffort)
    return { provider: t.provider, model: t.model, ...(effort ? { reasoningEffort: effort } : {}) }
  }
  const keyOf = (t) => (t ? `${t.provider}::${t.model}::${t.reasoningEffort || ''}` : '')

  /** 让聊天会话用面板里选的模型和思考强度；只改这个会话，不改 DSH 的默认模型。 */
  function applyModel(agent, target) {
    try {
      if (!target) return false
      const sel = { provider: target.provider, model: target.model }
      if (target.reasoningEffort) sel.reasoningEffort = target.reasoningEffort
      // 活着的会话只认会话控制器内存里的选择：用它的 selectForNextRequest（selectModel 也是调它，
      // 但 selectModel 还会顺手改掉 DSH 的全局默认模型，我们不要）。拿不到就只写持久事件（重启恢复时生效）。
      const agents = controller().agents
      if (agents && typeof agents.selectForNextRequest === 'function') agents.selectForNextRequest(agent, sel)
      else agent.session.append('model/selection', sel)
      return true
    } catch (error) {
      log.debug('设置会话模型失败（用默认）：', error.message)
      return false
    }
  }

  function mount(agent, chat, level) {
    const sid = sessionKey(agent.session?.id ?? agent.id)
    const tools = level !== 'chat' && typeof buildTools === 'function' ? buildTools({ chat, level, sessionId: sid }) : []
    const denied = (() => { try { return hooks?.deniedTools?.() || [] } catch (error) { return [] } })()
    // 模块（重）启动代际也进 key：热重载后工具名通常不变，但工具对象是旧实例的闭包（issue #73），
    // 只比名字会一直 return，会话里永远用旧实现/旧状态；带上代际就整套重挂。
    let gen = 0
    try { gen = typeof toolsGeneration === 'function' ? Number(toolsGeneration()) || 0 : 0 } catch (error) { gen = 0 }
    const toolsKey = tools.map((t) => t.name).sort().join(',') + '|' + denied.join(',') + '|gen:' + gen
    const prev = mounted.get(sid)
    // 工具清单变了（比如面板里开了生图）就整套重挂；同一个 agent 且没变就别动（改工具会让前缀缓存失效）
    if (prev && prev.agent === agent && prev.chatId === chat.chatId && prev.toolsKey === toolsKey) return
    if (prev) for (const off of prev.offs) { try { if (typeof off === 'function') off() } catch (error) {} }
    const offs = []
    // 联动工具是给 DSH 其他会话用的，她自己的 QQ 会话里不该有（陌生人的会话更不行）
    if (denied.length) {
      try { offs.push(agent.ctx.tools.restrict({ deny: denied })) } catch (error) { log.debug('屏蔽联动工具：', error.message) }
    }
    {
      for (const tool of tools) {
        try {
          // 慢工具（生图 / 翻唱……）卡超过 1.5 秒就先发一条提示：不让主人以为她没收到（issue #74）。
          // 包装只加在挂给 agent 的这份工具上；面板里直接调工具（host 路由）照旧。
          let reg = tool
          if (tool.slow) {
            const { slow, ...base } = tool
            const notice = typeof slow === 'string' ? slow : '好，我这就去做，做完跟你说一声。'
            reg = {
              ...base,
              async execute(args, exec) {
                let fired = false
                const timer = setTimeout(() => {
                  if (fired) return
                  fired = true
                  if (slowNoticeSent.has(sid)) return
                  slowNoticeSent.add(sid)
                  sendText(chat.chatId, notice, undefined, [], undefined).catch((error) => log.debug('慢工具提示没发出去：', error.message))
                }, 1500)
                timer.unref?.()
                try {
                  return await tool.execute(args, exec)
                } finally {
                  clearTimeout(timer)
                }
              },
            }
          }
          // 注册表里如果残留同名工具（旧 agent 作用域/旧版泄漏），先把我们记着的旧 disposer 清掉再注册
          const dkey = sid + '|' + tool.name
          const stale = toolDisposers.get(dkey)
          if (stale) { try { stale() } catch (error) {} toolDisposers.delete(dkey) }
          const off = agent.ctx.tools.register(reg)
          toolDisposers.set(dkey, off)
          offs.push(() => { toolDisposers.delete(dkey); try { off() } catch (error) {} })
        } catch (error) {
          // 「already registered in this scope」= 同名工具的旧实例还挂在同一 scope 上；
          // 实测功能不受影响（表情等工具照常可用，只是这一份注册失败），所以降成 debug 别刷屏。
          // 其余错误（参数不对、ctx 没准备好）才是真要看的，保持 warn。
          const dup = /already registered/i.test(error.message || '')
          if (dup) log.debug(`工具 ${tool.name} 已存在同名实例，跳过重复注册`)
          else log.warn(`工具 ${tool.name} 挂不上：`, error.message)
        }
      }
    }
    // 按聊天换人设：在这个 agent 的作用域里，用同一个变量名再注册一次，**遮蔽**全局那份。
    // 这样整份提示词里从头到尾只有一套人设 —— 以前的做法是往提示词里追加一块
    // 「【本聊天专用人设：X】…历史里的作废，从本段开始只按这一套说话」，结果是系统卡和
    // 追加块两套人设同时在场，模型要自己仲裁谁说了算（2026-11-05 群里就是这么打起来的）。
    // 现在那一块不存在了：这个群里只渲染专用卡，别的群和全局照旧。
    try {
      const cfg = getConfig()
      const want = personaIdFor(chat, cfg)
      const globalId = (cfg.persona || {}).current || ''
      if (want && want !== globalId && readPersona(want)) {
        // 打一行日志：重启后面板/日志里能直接看出「这个群用的是专用卡」而不是猜
        log.info(`${chat.chatId} 按聊天用人设 ${want}（遮蔽全局 ${globalId || '默认'}）`)
        offs.push(agent.ctx.systemPrompt.variable('qq_hub_persona', () => {
          // 每轮重读：面板里改了这张卡，下一轮就按新的说（和全局人设同一个行为）
          const p = readPersona(want)
          const body = p && p.body ? p.body : ''
          // 扩展模块能整段改写人设：全局那条走 rewrite('persona')，专用卡也走同一个 hook
          try {
            const next = hooks?.persona ? hooks.persona(body) : body
            return typeof next === 'string' ? next : body
          } catch (error) {
            return body
          }
        }))
      }
    } catch (error) {
      log.debug('按聊天挂人设失败：', error.message)
    }
    try {
      offs.push(agent.ctx.systemPrompt.context({
        name: 'qq-hub-context',
        order: 905,
        text: () => {
          const parts = []
          for (const p of contextProviders || []) {
            try {
              const t = p({ chat, sessionId: sid })
              if (t) parts.push(t)
            } catch (error) {}
          }
          return parts.join('\n\n')
        },
      }))
    } catch (error) {
      log.debug('挂上下文失败：', error.message)
    }
    mounted.set(sid, { agent, chatId: chat.chatId, offs, toolsKey })
  }

  // ---------- 发到 QQ ----------
  function targetOf(chatId) {
    const [kind, id] = String(chatId).split(':')
    return kind === 'group' ? { kind: 'group', id } : kind === 'private' ? { kind: 'private', id } : null
  }

  async function sendSegments(chatId, message, note, { force = false, onResult } = {}) {
    const cfg = getConfig()
    const tgt = targetOf(chatId)
    if (!tgt) return null
    // 身份泄露闸（移植自 surfcore 的 identity-guard）：出站前扫一遍「主人/别人的 QQ 号」。
    // 群聊里报自己这个群的群号是有用的（加白名单时就要说），所以把当前群号列为允许；
    // 主人的 QQ 号、别的群号、别人的号一律拦下——她在群里报过、在公开面报出去就收不回了。
    try {
      const igCfg = cfg.security?.identityGuard || {}
      if (igCfg.enabled !== false && !force) {
        const text = Array.isArray(message)
          ? message.filter((s) => s && s.type === 'text').map((s) => String(s.data?.text || '')).join('')
          : String(message || '')
        const ownGroup = chatId.startsWith('group:') ? chatId.slice(6) : ''
        const guard = checkIdentityLeak(text, {
          surface: tgt.kind === 'group' ? '群消息' : '私聊消息',
          ids: [cfg.ownerQQ, cfg.botQQ].filter(Boolean),
          allowIds: [ownGroup, ...(tgt.kind === 'private' ? [cfg.ownerQQ] : [])].filter(Boolean),
          // 私聊放宽裸长数字（与新区心同口径）：技术文档里的端口/版本号不该把整条吞掉
          allowBareNumbers: tgt.kind === 'private',
          mode: igCfg.mode === 'warn' ? 'warn' : 'block',
        })
        if (guard.hits.length) {
          if (!guard.ok) {
            log.warn(`身份泄露闸拦下 → ${chatId}：${guard.message}`)
            return null
          }
          log.warn(`身份泄露闸（仅告警）→ ${chatId}：${guard.message}`)
        }
      }
    } catch (error) { log.debug('身份泄露闸判定出错：', error.message) }
    // 扩展模块最后改一次（加签名、过滤敏感词、转发到别处……）；返回 null 就不发
    if (hooks?.send) {
      try {
        const next = await hooks.send(message, { chatId, note, force })
        if (next === null) { log.info(`扩展模块拦下了 → ${chatId}：${note}`); return null }
        if (Array.isArray(next)) message = next
      } catch (error) {
        log.warn('扩展模块改写发送内容出错：', error.message)
      }
    }
    const cap = captureStore.getStore()
    if (cap) {
      cap.push({ chatId, note, message })
      return { message_id: 'sim-' + cap.length }
    }
    // PR-1（ADR-0002）：开旗态物理发送转进统一 Outbox（台账/dryRun/闸在 egress 内收口），
    // 返回网关 raw 保持 legacy 返回形状；flag-off（egressRef.current=null）下面原路径一字未动。
    const eg = egressRef?.current
    if (eg) {
      const eAction = tgt.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      const eParams = tgt.kind === 'group' ? { group_id: Number(tgt.id), message } : { user_id: Number(tgt.id), message }
      const eDeliver = () => eg.deliver({ action: eAction, params: eParams, chatKey: chatId, receipt: 'required', note, sourceModuleId: 'hub', force })
      try {
        const eGr = tgt.kind === 'group' ? await groupQuota.send(tgt.id, eDeliver) : { ok: true, result: await eDeliver() }
        if (!eGr.ok) {
          bump('errors')
          log.warn(`发到 ${chatId} 失败：`, eGr.error?.message || '未知')
          onResult?.({ ok: false, unknown: eGr.error?.unknown === true, error: eGr.error })
          return null
        }
        // deliver 返回 null = 闸拦（试运行/开关/泄露闸），legacy「没发」语义，台账已记 cancelled
        if (eGr.result === null) { onResult?.({ ok: true, result: null, skipped: true }); return null }
        const r = eGr.result
        if (r && r.message_id !== undefined) {
          sentIds.add(String(r.message_id))
          if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value)
        }
        bump('sent')
        onResult?.({ ok: true, result: r })
        return r
      } catch (error) {
        bump('errors')
        log.warn(`发到 ${chatId} 失败：`, error.message)
        onResult?.({ ok: false, unknown: error?.unknown === true, error })
        return null
      }
    }
    if (force) {}
    else if (!cfg.enabled) {
      log.info(`总开关关着，没发 → ${chatId}：${note}`)
      return null
    }
    else if (cfg.dryRun) {
      log.info(`试运行（没真发）→ ${chatId}：${note}`)
      return null
    }
    const action = tgt.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = tgt.kind === 'group' ? { group_id: Number(tgt.id), message } : { user_id: Number(tgt.id), message }
    // 群消息走配额器：快满就等窗口，被限流就等一个窗口重试（否则消息真的丢）
    const doCall = () => onebot.call(action, params)
    try {
      const gr = tgt.kind === 'group'
        ? await groupQuota.send(tgt.id, doCall)
        : { ok: true, result: await doCall() }
      if (!gr.ok) {
        bump('errors')
        log.warn(`发到 ${chatId} 失败：`, gr.error?.message || '未知')
        // M1-C：向调用方如实报告投递状态——unknown = 副作用可能已发生（超时/中途断连），
        // 调用方（sendVoice 等）不得对该状态自动重试或改发另一形式
        onResult?.({ ok: false, unknown: gr.error?.unknown === true, error: gr.error })
        return null
      }
      const r = gr.result
      if (r && r.message_id !== undefined) {
        sentIds.add(String(r.message_id))
        if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value)
      }
      bump('sent')
      onResult?.({ ok: true, result: r })
      return r
    } catch (error) {
      bump('errors')
      log.warn(`发到 ${chatId} 失败：`, error.message)
      onResult?.({ ok: false, unknown: error?.unknown === true, error })
      return null
    }
  }

  /** replyId：要引用回复的那条 QQ 消息（可选）。 */
  const quote = (replyId) => (replyId ? [{ type: 'reply', data: { id: String(replyId) } }] : [])

  const mention = (userId, segs = []) => (userId && !segs.some((s) => s.type === 'at' && String(s.data?.qq) === String(userId)) ? [{ type: 'at', data: { qq: String(userId) } }, { type: 'text', data: { text: ' ' } }] : [])

  async function sendText(chatId, text, replyId, missed, userId) {
    // 文字里的 <face:名字> 换成 QQ 系统表情，和文字在同一条消息里；系统表情关着就去掉标签
    let body = text
    if (getConfig().stickers.faces) {
      // 表情别固化：同一条内重复、或与上一条撞名的，这次不夹（提示词劝不住就靠这层兜底）
      const d = dedupeFaces(body, interaction.facesUsed(chatId))
      if (d.text !== body) {
        body = d.text
        if (!body) return null
      }
      interaction.rememberFaces(chatId, d.used)
    }
    let segs = getConfig().stickers.faces ? textToSegments(body, faces.idOf) : [{ type: 'text', data: { text: stripFaceTags(body) } }]
    text = body
    // 群里的 @名字 / <at:QQ号> 换成真 @（对方会收到提醒）
    if (chatId.startsWith('group:') && hasMention(text)) segs = expandMentions(segs, await membersOf(chatId.slice(6)), missed)
    if (!segs.length || (segs.length === 1 && segs[0].type === 'text' && !segs[0].data.text.trim())) return null
    return sendSegments(chatId, [...quote(replyId), ...mention(userId, segs), ...segs], (replyId ? '[引用] ' : '') + text.slice(0, 60))
  }

  async function sendVoice(chatId, text, replyId, userId) {
    try {
      // 表情标签 / emoji 不念出来：TTS 只念能说的字（用户反馈：发语音时「呲牙」被读出来）
      const spoken = speakableText(text)
      if (!spoken) throw new Error('这条语音里只有表情/符号，没有能念的字')
      const { file, engine } = await tts.speak(spoken)
      const b64 = readFileSync(file).toString('base64')
      // QQ 客户端不支持「引用 / @ + 语音」同一条消息：这样发电脑 QQ 是空白气泡、手机 QQ 提示
      // 「该消息类型暂不支持查看」，语音也听不到（issue #103）。语音条一律单独成条，引用和 @ 只能放弃。
      if (replyId || userId) log.debug(`语音条不能带引用/@（QQ 限制），单独发：${chatId}`)
      let outcome = null
      const r = await sendSegments(chatId, [{ type: 'record', data: { file: 'base64://' + b64 } }], `[语音·${engine}] ${text.slice(0, 40)}`, { onResult: (o) => { outcome = o } })
      if (r || getConfig().dryRun || !getConfig().enabled) bump('voice')
      if (!r && getConfig().enabled && !getConfig().dryRun) {
        const err = new Error('网关没接受语音')
        err.unknown = outcome?.unknown === true
        throw err
      }
      return true
    } catch (error) {
      // M1-C：unknown（超时/中途断连，语音可能已经发出去了）不改发文字——
      // 那等于「盲发第二遍」；只有确定没发出去的失败才走文字兜底（voice 模块文档行为）
      if (error?.unknown) {
        log.warn(`语音发送状态未知（可能已发出），不改发文字：${chatId}`)
        return false
      }
      log.warn('语音没发出去，改发文字：', error.message)
      await sendText(chatId, text, replyId, undefined, userId)
      return false
    }
  }

  /** 戳回去：私聊戳对方，群里戳最近戳她的人（没人戳过就戳这一段最后说话的人）。 */
  async function pokeBack(chatId) {
    const cfg = getConfig()
    const group = chatId.startsWith('group:') ? chatId.slice(6) : ''
    const target = interaction.pokeBackTarget(chatId)
    if (!target) return
    const egP = egressRef?.current
    if (!egP && (!cfg.enabled || cfg.dryRun)) return log.info(`试运行（没真戳）→ ${chatId}：戳了戳 ${target}`)
    try {
      const pokeParams = { user_id: Number(target), ...(group ? { group_id: Number(group) } : {}) }
      const pokeRes = egP
        ? await egP.deliver({ action: 'send_poke', params: pokeParams, opts: { timeoutMs: 10000 }, chatKey: chatId, receipt: 'optional', note: `戳了戳 ${target}`, sourceModuleId: 'hub' })
        : await onebot.call('send_poke', pokeParams, { timeoutMs: 10000 })
      if (pokeRes === null) return // 闸拦（试运行/开关），台账已记 cancelled
      log.info(`${chatId}：她戳了戳 ${target}`)
    } catch (error) {
      log.debug('戳一戳失败：', error.message)
    }
  }

  /** 把一个音频文件当语音条发出去（翻唱用）。 */
  async function sendVoiceFile(chatId, file, note) {
    const b64 = readFileSync(file).toString('base64')
    const r = await sendSegments(chatId, [{ type: 'record', data: { file: 'base64://' + b64 } }], note || '[语音]')
    if (r || getConfig().dryRun || !getConfig().enabled) bump('voice')
    if (!r && getConfig().enabled && !getConfig().dryRun) throw new Error('网关没接受这条语音')
    return r
  }

  // 发文件：网关可能和插件不在同一台机器上（Docker / 远程 OneBot），它看不到本机路径，
  // 所以按本机路径发失败时，小文件会用 base64 再试一次；超时留长一点，别把大文件上传误判成失败。
  // 安全默认（#52）：功能默认关；只允许发 QQ 工作区（她平时写文件的地方）和面板里额外加的目录里的文件；
  // 单个文件有大小上限；只在主人私聊里能触发；发了什么会写进日志。
  const FILE_TIMEOUT_MS = 120_000
  const FILE_BASE64_MAX = 30 * 1024 * 1024
  const isExternalFile = (s) => /^(https?:\/\/|base64:\/\/)/i.test(s)
  const fileLabel = (name, src) => String(name || '').trim() || basename(src.split(/[?#]/)[0]) || '文件'
  const fileRootsOf = (cfg) => [workspaceDirOf(cfg), ...(Array.isArray(cfg?.files?.dirs) ? cfg.files.dirs : [])]
    .filter(Boolean)
    .map((d) => { try { return resolve(String(d)) } catch (error) { return '' } })
    .filter(Boolean)
  const insideRoots = (file, roots) => {
    let p
    try { p = resolve(file) } catch (error) { return false }
    return roots.some((root) => {
      const rel = relative(root, p)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
  }

  /** 把一个文件当文件发到 QQ（OneBot upload_private_file / upload_group_file）。file 可以是本机绝对路径、网址或 base64://。 */
  async function sendFile(chatId, file, name) {
    const cfg = getConfig()
    const tgt = targetOf(chatId)
    if (!tgt) return null
    if (!cfg.files?.enabled) throw new Error('发文件没打开（面板「聊天」页 → 发文件），打开后才能发')
    const src = String(file ?? '').trim()
    if (!src) throw new Error('要发哪个文件？')
    const external = isExternalFile(src)
    const maxBytes = Math.max(1, Number(cfg.files.maxMB) || 50) * 1024 * 1024
    let size = 0
    if (!external) {
      if (!isAbsolute(src)) throw new Error('要发本机文件得给绝对路径')
      if (!existsSync(src)) throw new Error(`找不到这个文件：${src}`)
      const st = statSync(src)
      if (!st.isFile()) throw new Error(`这不是文件：${src}`)
      size = st.size
      const roots = fileRootsOf(cfg)
      if (roots.length && !insideRoots(src, roots)) throw new Error('这个文件不在允许发送的目录里（面板「聊天」页 → 发文件 可以加目录）')
      if (size > maxBytes) throw new Error(`文件太大（${(size / 1024 / 1024).toFixed(1)} MB），上限 ${Math.round(maxBytes / 1024 / 1024)} MB`)
    }
    const label = fileLabel(name, src)
    // 模拟测试：只记下来，不真发
    const cap = captureStore.getStore()
    if (cap) {
      cap.push({ chatId, note: `[文件] ${label}`, message: [{ type: 'file', data: { file: src, name: label } }] })
      return { message_id: 'sim-' + cap.length }
    }
    if (!egressRef?.current && !cfg.enabled) { log.info(`总开关关着，没发 → ${chatId}：[文件] ${label}`); return null }
    if (!egressRef?.current && cfg.dryRun) { log.info(`试运行（没真发）→ ${chatId}：[文件] ${label}`); return null }
    const action = tgt.kind === 'group' ? 'upload_group_file' : 'upload_private_file'
    const params = tgt.kind === 'group'
      ? { group_id: Number(tgt.id), file: src, name: label }
      : { user_id: Number(tgt.id), file: src, name: label }
    // PR-1：开旗态文件上传转进统一 Outbox（receipt optional：upload 回执是 file_id 不是 message_id）
    const callFile = egressRef?.current
      ? (p) => egressRef.current.deliver({ action, params: p, opts: { timeoutMs: FILE_TIMEOUT_MS }, chatKey: chatId, receipt: 'optional', note: `[文件] ${label}`, sourceModuleId: 'hub' })
      : (p) => onebot.call(action, p, { timeoutMs: FILE_TIMEOUT_MS })
    const srcLabel = external ? (src.startsWith('base64://') ? 'base64' : '外部地址') : size < 1024 ? size + ' B' : Math.round(size / 1024) + ' KB'
    try {
      const r = await callFile(params)
      if (r === null) return null // 闸拦（试运行/开关/泄露闸），台账已记 cancelled
      bump('sent')
      log.info(`${chatId}：发文件「${label}」（${srcLabel}）`)
      return r
    } catch (error) {
      // 网关看不到本机路径（远程 / 容器）时，小文件改用 base64 再试。
      // M1-C：只允许在「确定没发出去」的失败上走这个约定内 fallback
      // （网关明确拒绝 / 连接没建立起来）；unknown（超时、中途断连）可能已经
      // 发出去了，再补一发 base64 就是重复文件。
      const canRetryBase64 = !external && size <= Math.min(FILE_BASE64_MAX, maxBytes) && error?.unknown !== true
      if (!canRetryBase64) {
        bump('errors')
        throw new Error(`发文件失败：${error.message}`)
      }
      try {
        const b64 = 'base64://' + readFileSync(src).toString('base64')
        const r = await callFile({ ...params, file: b64 })
        if (r === null) return null
        bump('sent')
        log.info(`${chatId}：发文件「${label}」（网关看不到本机路径，改走 base64）`)
        return r
      } catch (error2) {
        bump('errors')
        throw new Error(`发文件失败：${error2.message || error.message}`)
      }
    }
  }

  async function sendSticker(chatId, query, replyId, userId) {
    // 面板里把表情包关了：回复里的 <sticker:…>、工具、扩展模块要发的一律不发（#31）
    if (!getConfig().stickers.enabled) {
      log.debug(`表情包关着，「${typeof query === 'object' ? query?.name || '' : query}」不发`)
      return false
    }
    const item = query && typeof query === 'object' ? query : stickers.match(query)
    if (!item) {
      log.debug(`没找到「${query}」这张表情，跳过`)
      return false
    }
    const seg = stickers.segmentFor(item)
    if (!seg) return false
    await sendSegments(chatId, [...quote(replyId), ...mention(userId), seg], `[表情] ${item.name || item.md5.slice(0, 8)}`)
    stickers.markUsed?.(item.md5)
    bump('stickers')
    return true
  }

  async function sendImage(chatId, src, replyId, userId) {
    try {
      const buf = await fetchImage(src, { maxBytes: 10 * 1024 * 1024, allowLocal: true })
      return sendSegments(chatId, [...quote(replyId), ...mention(userId), { type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[图片] ${src.slice(-40)}`)
    } catch (error) {
      log.warn('图片发不出去：', error.message)
      return null
    }
  }

  /** 一轮回复落地：拆条、语音、表情。 */
  async function deliver(chatId, text, opts = {}) {
    const cfg = getConfig()
    if (hooks?.reply) {
      try {
        const next = await hooks.reply(text, { chatId, userText: opts.userText || '' })
        if (next === null) return log.info(`${chatId}：扩展模块拦下了这次回复`)
        if (typeof next === 'string') text = next
      } catch (error) {
        log.warn('扩展模块改写回复出错：', error.message)
      }
    }
    // 分条规则跟着配置走：她自己断的句优先，字数只当兜底（群里与私聊上限可以不同）
    const rules = replyRules(cfg, chatId.startsWith('group:'))
    // 报告兜底（1.3.48 第二层）：这一轮确实调过「内容型工具」（RSS、B 站、小黑盒这类查资料的），
    // 但她忘了写 <report> 标记 → 整轮按报告处理，不被拆碎。记忆型工具（recall_memory 等）不算。
    if (opts.forceReport || reportTurns.get(chatId)) rules.forceReport = true
    // 只有一个判断分条的地方：规则。她怎么断（|||）写在提示词里，规则只负责认和收尾。
    // 1.3.43 删掉了「多问一次模型挑断点」——那是第二个权威，会跟规则打架，
    // 而且每次都要多等一次模型往返（免费中转一卡，整条回复跟着卡住发不出去）。
    const r = parseReply(text, rules)
    if (r.silent) {
      log.info(`${chatId}：她选择不说话`)
      if (chatId.startsWith('group:')) groups.leaveTopic(chatId.slice(6)) // 不想聊就退出这个话题
      return
    }
    let items = r.items
    // 对方明确要语音、她却只打了字：整段改成语音发（模型偶尔会忘，这里兜底）
    if (opts.wantVoice && cfg.voice.enabled && !items.some((i) => i.kind === 'voice')) {
      const spoken = items.filter((i) => i.kind === 'text').map((i) => i.value).join('，')
      if (spoken && spoken.length <= 300) items = [{ kind: 'voice', value: spoken }, ...items.filter((i) => i.kind !== 'text')]
    }
    // 短回复按概率整条变语音
    const texts = items.filter((i) => i.kind === 'text')
    if (cfg.voice.enabled && items.length === texts.length && texts.length > 0) {
      const all = texts.map((t) => t.value).join('，')
      if (all.length <= cfg.voice.autoMaxChars && Math.random() < cfg.voice.autoChance * mood().voice) items = [{ kind: 'voice', value: all }]
    }
    const inGroup = chatId.startsWith('group:')
    // 群里别刷屏：一段最多 3 条 —— 但**超出的部分不能丢**。
    // 原来这里直接 slice(0,3)，第 4 条起静默消失（2026-11-04 真实事故：
    // 她答「备用码」讲了四段，群里只出现第一段，用户看到的是「没回答完就停了」）。
    // 现在把多出来的并进第 3 条，宁可这一条长一点，也不让话少一半。
    if (inGroup && items.length > 3) {
      // 文本合并成气泡，**非文本（表情/图片/戳）保留成独立 item**。
      // 上一版把非文本也拼成了字符串（"× y [sticker]" 这种），结果表情变成
      // 字面文本发到群里 —— 群里真的出现了「[sticker]」这三个字（2026-11-04 事故）。
      const nonText = items.filter((i) => i.kind !== 'text' && i.kind !== 'voice')
      const texts = items.filter((i) => i.kind === 'text' || i.kind === 'voice').map((i) => String(i.value || '')).filter(Boolean)
      // 非文本最多留 2 条（表情/图片本来就该是独立气泡），其余名额给文本
      const keepNonText = nonText.slice(-2)
      const textSlots = Math.max(1, 3 - keepNonText.length)
      const mergedTexts = []
      for (let i = 0; i < texts.length; i += 1) {
        if (mergedTexts.length === textSlots - 1) { mergedTexts.push(texts.slice(i).join(' ')); break }
        mergedTexts.push(texts[i])
      }
      items = [...mergedTexts.map((v) => ({ kind: 'text', value: v })), ...keepNonText]
      log.info(`${chatId}：回复超过 3 条，合并成 ${mergedTexts.length} 条文字 + ${keepNonText.length} 条非文字（不丢内容，表情原样保留）`)
    }
    // 按概率补一张表情（群里已经有两条以上就不补了）
    if (cfg.stickers.enabled && !items.some((i) => i.kind === 'sticker') && !(inGroup && items.length >= 2) && Math.random() < cfg.stickers.autoChance * mood().sticker) {
      const pick = stickers.pickForReply(texts.map((t) => t.value).join(' '))
      if (pick) items.push({ kind: 'sticker', value: pick })
    }
    if (hooks?.items) {
      try {
        const next = await hooks.items(items, { chatId, text, userText: opts.userText || '' })
        if (next === null) return log.info(`${chatId}：扩展模块拦下了这次回复`)
        if (Array.isArray(next)) items = next
      } catch (error) {
        log.warn('扩展模块改写回复出错：', error.message)
      }
    }
    // 一段只有一个人明确 @ / 引用她时，第一条回复引用并 @ 那个人；多人同时叫她不猜。
    // 模型明确选了引用编号时尊重它，不再自动引用另一条。
    const refs = inGroup ? (opts.refs || groups.refs(chatId.slice(6))) : {}
    const explicit = items.some((item) => item.replyTo)
    const firstSendable = items.findIndex((item) => item.kind === 'text' || item.kind === 'voice' || item.kind === 'image' || (item.kind === 'sticker' && cfg.stickers.enabled && Boolean(item.value && typeof item.value === 'object' ? item.value : stickers.match(item.value))))
    const missedAt = [] // 写了 @ 却没对上群里人的名字
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const selected = it.replyTo ? refs[it.replyTo] : (!explicit && i === firstSendable ? opts.autoReply : null)
      const replyId = selected?.mid
      const userId = selected && opts.autoReply?.uid === selected.uid ? selected.uid : undefined
      if (it.replyTo && !replyId) log.debug(`${chatId}：引用的编号 ${it.replyTo} 对不上，正常发`)
      if (it.kind === 'text') await sendText(chatId, it.value, replyId, missedAt, userId)
      else if (it.kind === 'voice') {
        if (cfg.voice.enabled) await sendVoice(chatId, it.value, replyId, userId)
        else await sendText(chatId, it.value, replyId, missedAt, userId)
      } else if (it.kind === 'sticker') await sendSticker(chatId, it.value, replyId, userId)
      else if (it.kind === 'poke') { if (!opts.simulate) await pokeBack(chatId) }
      else if (it.kind === 'image') await sendImage(chatId, it.value, replyId, userId)
      if (i < items.length - 1 && !opts.simulate) await sleep(bubbleDelay(items[i + 1].kind === 'text' ? items[i + 1].value : '') * mood().delay)
    }
    if (opts.simulate) return items
    if (inGroup) {
      const gid = chatId.slice(6)
      groups.noteSpeak(gid)
      groups.noteSpokeInGroup(gid) // 在群里说了话 = 加入了话题
    }
    const said = items.map((i) => (i.kind === 'text' || i.kind === 'voice' ? i.value : `[${i.kind}]`)).join(' ')
    logChat(chatId, 'bot', said)
    // 不是这个聊天自己那一轮发的（主人在私聊里让她去群里说、扩展模块代发）：记下来，下次这个聊天交给她时告诉她自己说过什么
    if (!opts.own) interaction.queueAside(chatId, said)
    lastChatAt = Date.now()
    if (chatId === `private:${cfg.ownerQQ}`) lastBotToOwner = { at: Date.now(), text: items.filter((i) => i.kind === 'text' || i.kind === 'voice').map((i) => i.value).join('\n') }
    onActivity?.({ kind: 'out', chatId, reply: text, userText: opts.userText || '' })
    return { missedAt }
  }

  // ---------- 盯 DSH 会话：一轮结束就发 ----------
  function textOf(message) {
    if (!message || !Array.isArray(message.content)) return ''
    return message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
  }

  function onSessionEvent(session, event) {
    const key = sessionKey(session && session.id)
    const chatId = sessionToChat.get(key)
    if (!chatId || !event) return
    const st = turnState.get(key) || { lastTurn: -1, text: '', senders: new Set() }
    turnState.set(key, st)
    if (event.type === 'user/message') {
      // 主人在 DSH 会话窗口里直接打字（不是从 QQ 转进来的，#58）：只有主人能操作 DSH，
      // 这一轮按「主人说的」算；不然重开会话后在面板里让她改资料会报没权限。
      const src = event.data && event.data.source
      if (src && src.kind === 'user') st.directOwner = true
      return
    }
    if (event.type === 'tool/call') {
      // 报告兜底（1.3.48 第二层）：这一轮调了「内容型工具」（查资料/拉列表的），
      // 她的回复多半是数据排版，忘了写 <report> 也按报告整段发。记忆/管理型工具不算。
      const name = String(event.data?.name || '')
      if (CONTENT_TOOLS.test(name)) reportTurns.set(chatId, true)
      return
    }
    if (event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) return
      const t = textOf(d.message)
      if (t) {
        st.lastTurn = d.turn
        st.text = t
      }
      return
    }
    if (event.type === 'question/requested') {
      const qData = event.data || {}
      if (Array.isArray(qData.questions) && qData.questions.length) {
        questions.ask(chatId, {
          questions: qData.questions,
          signal: qData.signal
        }).catch((err) => log.debug('提问事件处理异常:', err.message))
      }
      return
    }
    if (event.type === 'approval/requested') {
      const aData = event.data || {}
      approvals.request(aData, {
        chatId,
        sessionId: key,
        command: aData.command || aData.arguments?.command,
        args: aData.arguments
      }).catch((err) => log.debug('审批事件处理异常:', err.message))
      return
    }
    if (event.type === 'turn/end') {
      slowNoticeSent.delete(key)
      running.delete(chatId)
      reportTurns.delete(chatId) // 报告兜底只管一轮：下一轮是不是报告，看下一轮调了什么
      stopTyping(key)
      const d = event.data || {}
      const completed = d.reason && d.reason.kind === 'completed'
      const text = st.lastTurn === d.turn ? st.text : ''
      const sys = st.system
      const wantVoice = Boolean(st.wantVoice)
      const autoReply = st.autoReply
      st.autoReply = null
      st.text = ''
      // 上一轮还在跑时新消息已经排队给「下一轮」：这一轮 turn/end 不能把下一轮的说话人清掉（#90）
      st.senders = st.pendingSenders || new Set()
      st.pendingSenders = new Set()
      st.directOwner = false
      st.system = null
      st.wantVoice = false
      if (sys) {
        if (completed) sys.resolve(text)
        else sys.reject(new Error('这一轮没正常结束：' + (d.reason?.kind || '?')))
        return
      }
      if (!completed) {
        const detail = String(d.reason?.error?.message || d.reason?.failure?.message || '').replace(/\s+/g, ' ').slice(0, 180)
        log.warn(`${chatId} 这一轮没正常结束（${d.reason?.kind || '?'}${detail ? '：' + redact(detail) : ''}），不发`)
        release(chatId)
        return
      }
      if (chatId.startsWith('system:')) return // 已超时的后台轮次不能误发到 QQ
      if (!text) return release(chatId)
      // 发完再放开：发送期间来的消息也攒到下一段
      deliver(chatId, text, { wantVoice, autoReply, userText: st.lastText || '', own: true }).catch((error) => log.warn('发送出错：', error.message)).finally(() => release(chatId))
    }
  }

  // ---------- 收 QQ ----------
  async function groupName(gid) {
    if (groupNames.has(gid)) return groupNames.get(gid)
    try {
      // 查群名是锦上添花：失败就退回群号，别在网关抖动时白等重试
      const info = await onebot.call('get_group_info', { group_id: Number(gid) }, { retries: 0 })
      if (info?.group_name) groupNames.set(gid, info.group_name)
    } catch (error) {}
    return groupNames.get(gid) || gid
  }

  // ---------- 引用消息 ----------
  // QQ 的引用段只有 message_id，正文要用 get_msg 再取一次。取到后把「谁、说了什么、几张图」带上；
  // 取不到也记一笔，让她知道「这条引用没读到」，可以如实说没看到（别装作看见了）。
  const QUOTE_CACHE_MAX = 200
  /** 表情包/图片段里有没有能直接下载的地址（有些 get_msg 只回了空 url + 裸文件名）。 */
  const quoteSegUsable = (seg) => {
    const d = (seg && seg.data) || {}
    return [d.url, d.file].some((x) => typeof x === 'string'
      && (/^https?:\/\//i.test(x) || x.startsWith('base64://') || x.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(x)))
  }
  const quoteNeedsHistory = (parsed) => [...(parsed.images || []), ...(parsed.stickers || [])].some((seg) => !quoteSegUsable(seg))
  /**
   * get_msg 对「她发出的表情包/图片」可能只回空 url + 裸文件名（下载不了）。
   * 这时退回消息历史（get_friend_msg_history / get_group_msg_history），里面带可用 url。
   */
  async function quoteFromHistory(id, ctx) {
    if (!ctx || (!ctx.userId && !ctx.groupId)) return null
    const group = Boolean(ctx.groupId)
    const action = group ? 'get_group_msg_history' : 'get_friend_msg_history'
    const base = group ? { group_id: Number(ctx.groupId) } : { user_id: Number(ctx.userId) }
    // 先用引用 id 当锚点（能取到更早的消息），拿不到再退回「最近 30 条」
    const anchor = /^-?\d+$/.test(id) ? Number(id) : 0
    const attempts = anchor
      ? [{ ...base, message_id: anchor, count: 5, reverse_order: false }, { ...base, count: 30 }]
      : [{ ...base, count: 30 }]
    for (const params of attempts) {
      try {
        const r = await onebot.call(action, params, { timeoutMs: 8000, retries: 0 })
        const hit = (r?.messages || []).find((m) => String(m?.message_id ?? '') === id || String(m?.real_id ?? '') === id)
        if (hit) return hit
      } catch (error) {
        log.debug(`引用消息历史也拉不到（${id}）：`, error.message)
      }
    }
    return null
  }
  async function quotedInfo(replyId, ctx = null) {
    const id = String(replyId || '')
    if (!id) return null
    if (quoteCache.has(id)) return quoteCache.get(id)
    const out = { ok: false, who: '', uid: '', text: '', images: [], stickers: [], records: 0, isBot: false, at: 0 }
    try {
      const m = await onebot.call('get_msg', { message_id: Number(id) || id }, { timeoutMs: 5000, retries: 0 })
      const sender = m?.sender || {}
      out.uid = String(sender.user_id ?? m?.user_id ?? '')
      out.who = String(sender.card || sender.nickname || out.uid || '某人')
      const kind = ctx?.groupId ? 'group' : 'private'
      let parsed = parseMessageEvent({ message_type: kind, group_id: ctx?.groupId, user_id: out.uid, sender, message: m?.message ?? m?.raw_message ?? '' }, selfId, { faceName: faces.nameOf })
      if (quoteNeedsHistory(parsed)) {
        const hit = await quoteFromHistory(id, ctx)
        if (hit) {
          const again = parseMessageEvent({ message_type: kind, group_id: ctx?.groupId, user_id: out.uid, sender: hit.sender || sender, message: hit.message ?? '' }, selfId, { faceName: faces.nameOf })
          if (!quoteNeedsHistory(again)) parsed = again
          else { parsed.images = [...(parsed.images || []), ...(again.images || [])]; parsed.stickers = [...(parsed.stickers || []), ...(again.stickers || [])] }
        }
      }
      out.text = String(parsed.text || '').trim().slice(0, 300)
      out.images = parsed.images || []
      out.stickers = parsed.stickers || []
      out.records = (parsed.records || []).length
      out.isBot = out.uid === String(selfId || getConfig().botQQ)
      out.ok = true
      out.at = Date.now()
    } catch (error) {
      log.debug(`引用消息没拉到（${id}）：`, error.message)
    }
    if (quoteCache.size >= QUOTE_CACHE_MAX) quoteCache.delete(quoteCache.keys().next().value)
    quoteCache.set(id, out)
    return out
  }

  // 引用里是主人时也不带号码（和群聊标注一个口径）
  const quoteWho = (q) => (q.isBot ? '你' : (String(q.uid) === String(getConfig().ownerQQ || '') && getConfig().ownerQQ ? '主人' : `${q.who || q.uid || '某人'}${q.uid ? `(${q.uid})` : ''}`))
  const quoteBody = (q) => {
    const body = String(q.text || '').replace(/\[(图片|表情包)\]/g, '').trim()
    if (body) return body
    if (q.images.length) return '（图片）'
    if (q.records) return '（语音）'
    if (q.stickers.length) return '（表情包）'
    return '（没有文字）'
  }
  /** 引用说明：群聊接在某条消息后面，私聊单独一行。失败时明说没读到，让她可以如实讲。 */
  const quoteInline = (q) => {
    if (!q) return ''
    if (!q.ok) return '（引用了某条消息，但内容没读到；如果影响理解，可以如实说没看到，让对方重发或说一下是哪条）'
    const pics = q.images.length && q.stickers.length
      ? `，另有 ${q.images.length} 张图、${q.stickers.length} 个表情包`
      : q.images.length ? `，另有 ${q.images.length} 张图`
      : q.stickers.length ? `，另有 ${q.stickers.length} 个表情包`
      : q.records ? '，一条语音' : ''
    return `（引用 ${quoteWho(q)} 的消息：「${quoteBody(q)}」${pics}）`
  }
  /** 引用里的图片 / 表情包：最多 take 张转成附件；模型看不了图就只留上面的文字说明。 */
  async function quoteImages(q, take = 2) {
    if (!q?.ok || take <= 0) return []
    const segs = [...q.images, ...q.stickers].slice(0, take)
    if (!segs.length) return []
    if ((await canSeeImages(dsh, getConfig())) === false) return []
    const { images: got } = await imagesOf({ stickers: [], images: segs })
    return got.map((x, i) => ({ type: 'image', data: x.data, mediaType: x.mediaType, name: `quote-${q.uid || 'x'}-${i + 1}` }))
  }

  async function repliedToBot(replyId, msg) {
    if (!replyId) return false
    if (sentIds.has(replyId)) return true
    const q = await quotedInfo(replyId, msg)
    return Boolean(q && q.ok && q.isBot)
  }

  async function transcribe(msg) {
    for (const rec of msg.records) {
      // 本地接口接管：用用户自己的识别服务（最先试）
      if (localApi?.active('asr')) {
        try {
          const info = await onebot.call('get_record', { file: rec.data?.file, out_format: 'wav' }, { timeoutMs: 30000 })
          const raw = info?.base64 ? Buffer.from(info.base64, 'base64') : await fetchImage(info?.file || info?.url, { maxBytes: 30 * 1024 * 1024, allowLocal: true })
          const { writeFileSync, mkdirSync } = await import('node:fs')
          const { join } = await import('node:path')
          const dir = localApi.dir() + '/out'
          mkdirSync(dir, { recursive: true })
          const file = join(dir, `asr-${Date.now()}.wav`)
          writeFileSync(file, toMono16k(raw))
          const r = await localApi.call('asr', { file })
          const text = String(typeof r === 'string' ? r : r?.text || '').trim()
          if (text) return `[语音] ${text}`
        } catch (error) {
          log.debug('本地接口语音识别失败：', error.message)
        }
      }
      try {
        const r = await onebot.call('fetch_ptt_text', { message_id: Number(msg.messageId) || msg.messageId }, { timeoutMs: 20000 })
        if (r?.text) return `[语音] ${r.text}`
      } catch (error) {
        log.debug('QQ 语音转文字失败：', error.message)
      }
      try {
        const text = await localTranscribe(rec)
        if (text) return `[语音] ${text}`
      } catch (error) {
        log.debug('本地语音识别失败：', error.message)
      }
      return '[发来一条语音，没听清]'
    }
    return ''
  }

  /**
   * DSH 自带识别（SenseVoice）：resolve({audio}) → transcribe(spec, signal)，音频必须是 16kHz 单声道 PCM16 WAV。
   * QQ 语音是 silk：先让网关 get_record 转成 wav，再重采样。
   */
  async function localTranscribe(rec) {
    const stt = dsh.get('speechToText')
    if (!stt || typeof stt.resolve !== 'function' || typeof stt.transcribe !== 'function') throw new Error('DSH 没开启语音输入')
    // 模型还没下载好：顺手开始准备（下载一次，之后常驻），这一条先算没听清
    const snap = typeof stt.snapshot === 'function' ? stt.snapshot() : null
    const pid = snap?.selection?.providerId
    const prov = snap?.providers?.find((p) => p.id === pid)
    if (prov && prov.preparation && !['ready', 'standby'].includes(prov.preparation.phase)) {
      try { stt.prepare(pid) } catch (error) {}
      throw new Error(`识别模型还在准备（${prov.preparation.phase}）`)
    }
    const info = await onebot.call('get_record', { file: rec.data?.file, out_format: 'wav' }, { timeoutMs: 30000 })
    const raw = info?.base64 ? Buffer.from(info.base64, 'base64') : await fetchImage(info?.file || info?.url, { maxBytes: 30 * 1024 * 1024, allowLocal: true })
    const spec = stt.resolve({ audio: new Uint8Array(toMono16k(raw)) })
    const r = await stt.transcribe(spec, AbortSignal.timeout(60000))
    const text = typeof r === 'string' ? r : r?.text || r?.transcript
    return text ? String(text).trim() : ''
  }

  /**
   * 把消息里的图 / 表情包取成可以交给模型的块。
   * 返回 { images, failed }：failed 是「有图但没取成」的张数，调用方据此补一句文字说明。
   * 原来认不出类型就 continue 静默丢掉，模型那边只看到一句「[表情包]」，
   * 用户看到的就是「她看不懂表情包」——所以这里必须把失败也说出去。
   */
  async function imagesOf(msg) {
    const out = []
    let failed = 0
    for (const seg of [...msg.stickers, ...msg.images].slice(0, 4)) {
      try {
        const buf = await segmentBytes(seg, onebot, { maxBytes: 8 * 1024 * 1024 })
        const mime = mimeOf(buf)
        if (!mime.startsWith('image/')) {
          // 认不出是什么图：不猜，但记账，让它变成一句「收到了但打不开」
          failed++
          log.warn(`${msg.chatId} 有一张图认不出类型（${buf.length} 字节，头 ${buf.slice(0, 12).toString('hex')}），没交给模型`)
          continue
        }
        out.push({ data: buf.toString('base64'), mediaType: mime })
      } catch (error) {
        failed++
        log.warn(`${msg.chatId} 图片下载失败：${error.message}`)
      }
    }
    return { images: out, failed }
  }

  /**
   * 把这一条消息里带的文件都取下来。
   * 只取前 3 个，单个最大 20MB；文本类直接解码成正文给她读，
   * 其它类型落到工作目录再把路径告诉她（她自己用工具读）。
   */
  /**
   * 主模型看不了图时，这一批图片该变成什么文字。
   * 配了辅助看图模型就请它转述（带来源标注）；没配/失败就给一句如实的说明。
   * 私聊和群聊共用一份，避免两处写法不一致（以前群聊直接丢掉，连提示都没有）。
   * @returns {Promise<string>} 要拼进提示词的文字（永不为空）
   */
  async function imageTextFor (imgs, nickname, cfg, hint) {
    const h = cfg && cfg.visionHelper
    const usable = h && h.enabled && h.provider && h.model
    if (usable && imgs.length) {
      try {
        const desc = await describeWithHelper(dsh, { images: imgs, cfg, hint, log })
        if (desc) {
          return `（${nickname} 发了 ${imgs.length} 张图片。你的模型看不了图，下面由另一个模型看过之后转述给你，别当成你亲眼见过：\n${desc}）`
        }
      } catch (error) {
        log.debug('辅助看图失败：', error.message)
      }
    }
    return `（${nickname} 发了 ${imgs.length} 张图片，你现在的模型看不了图，只能知道有这么回事）`
  }

  async function filesOf(msg) {
    return readInboundFiles(msg, { onebot, workspaceDir: workspaceDirOf(getConfig()), log })
  }

  async function onMessage(event, opts = {}) {
    selfId = String(event.self_id || selfId || getConfig().botQQ)
    const cfg = getConfig()
    const msg = parseMessageEvent(event, selfId, { faceName: faces.nameOf })
    if (msg.userId === selfId) return
    // 按群头衔过滤：这条当没看见（不进群聊上下文、不触发回复，@ 她、主人命令也一样）
    bump('received')
    const now = Date.now()

    // 群里的每条消息都记进缓冲（给上下文和「群里在不在聊」用）
    let groupEntry = null
    if (msg.kind === 'group') {
      groupEntry = groups.appendMessage(msg.groupId, {
        t: now, uid: msg.userId, nick: msg.nickname, text: msg.text, at: msg.mentioned, mid: msg.messageId, direct: false, replyId: msg.replyId,
      })
    }

    const allowed = checkAllowed(cfg, msg)
    // 偷表情：只从白名单里的会话偷；按 collectMode 分三种
    //   auto  = 全都偷（看到就收）
    //   ask   = 她挑（先记着，给她一句轻提示，她喜欢才凭编号收）
    //   owner = 只听主人的：先记着，但只有主人发来的表情才提示她收；
    //           真正能不能收由工具那边再按「这一轮说话的全是主人」把关
    let stickerPick = 0
    const collectMode = cfg.stickers.collectMode || 'auto'
    if (allowed.allowed && msg.stickers.length && cfg.stickers.collect) {
      const okSrc = msg.kind === 'group' ? cfg.stickers.fromGroups : cfg.stickers.fromPrivate
      if (okSrc) {
        if (collectMode === 'auto') {
          for (const s of msg.stickers) stickers.collect(s, msg.chatId).then((r) => { if (!r.ok) log.debug('没收这张表情：', r.reason) }).catch(() => {})
        } else {
          stickerPick = rememberStickers(msg.chatId, msg.stickers)
          // 只听主人的：别人发的先悄悄记着（主人之后说「收下那张」还能用），但不提示她
          if (collectMode === 'owner' && !isOwner(cfg, msg.userId)) stickerPick = 0
        }
      }
    }
    if (!allowed.allowed) {
      log.debug(`忽略 ${msg.chatId}（${allowed.reason}）`)
      return
    }

    // 审批指令（「通过 #1」「拒绝」等）：只认主人，优先拦截处理
    if (approvals.handleReply(msg.text, msg.userId, msg.chatId)) {
      logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
      return
    }

    // 交互式提问（ask_user_question）：当前聊天若正等待回答，优先由提问状态机消费
    if (questions.has(msg.chatId) && questions.handleReply(msg.chatId, msg.text)) {
      logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
      return
    }

    // 最近发来的图片 / 表情记几张（「把刚才那张存下来」时用）
    if (msg.stickers.length || msg.images.length) {
      recentMedia.remember(msg.chatId, [...msg.stickers, ...msg.images].map((seg) => ({ seg, userId: msg.userId, sticker: msg.stickers.includes(seg) })))
    }
    // 主人命令（/silent /active …）：总开关关着也处理，回复直接发
    if (onCommand && isOwner(cfg, msg.userId) && /^\s*[/／]/.test(msg.text)) {
      try {
        const reply = await onCommand(msg)
        if (reply) {
          log.info(`主人命令 ${msg.text.trim().slice(0, 30)} → ${reply.split('\n')[0]}`)
          await sendSegments(msg.chatId, [{ type: 'text', data: { text: reply } }], reply.slice(0, 60), { force: true })
          return
        }
      } catch (error) {
        log.warn('执行命令出错：', error.message)
        await sendSegments(msg.chatId, [{ type: 'text', data: { text: '命令没执行成功：' + error.message } }], '命令出错', { force: true })
        return
      }
    }
    if (!getConfig().enabled) {
      log.info(`总开关关着，收到 ${msg.chatId} 的消息但不处理：${msg.text.slice(0, 30)}`)
      return
    }

    if (isMuted?.(msg.chatId)) {
      log.debug(`${msg.chatId}：主人让她闭嘴中，不回`)
      logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
      return
    }

    // 扩展模块可以先接管这条消息（关键词回复、转给自己的服务……）
    if (hooks?.message) {
      try {
        if (await hooks.message({ ...msg, raw: event })) {
          logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
          return
        }
      } catch (error) {
        log.warn('扩展模块处理消息出错：', error.message)
      }
    }

    let mode = 'must'
    if (msg.kind === 'group') {
      const pol0 = policyFor(cfg.group, cfg.group.overrides, msg.groupId)
      // 心情好更爱插话，心情差少插话
      const pol = { ...pol0, interjectChance: Math.min(1, pol0.interjectChance * mood().chatty) }
      // 群里最近在聊的（窗口内最后几条）和她有多相关
      const recentTexts = groups.buffer(msg.groupId).filter((x) => now - x.t < pol.activeWindowSec * 1000).slice(-6).map((x) => x.text)
      let memScore = 0
      // 带上当前群：话题相关度只在这个群可见的记忆里算，主人私聊记的东西不该让她在这个群「感兴趣」
      const memChat = { chatId: msg.chatId, kind: 'group', groupId: msg.groupId }
      try { memScore = typeof memoryScore === 'function' ? memoryScore(recentTexts.join(' '), memChat) : 0 } catch (error) {}
      const quotedBot = await repliedToBot(msg.replyId, msg)
      const decision = decideGroupReply({
        policy: pol,
        relevance: topicRelevance(recentTexts, pol.interests, memScore),
        engagedUntil: groups.engagedUntil(msg.groupId),
        mentioned: msg.mentioned,
        repliedToBot: quotedBot,
        fromOwner: isOwner(cfg, msg.userId),
        text: msg.text,
        now,
        hour: new Date().getHours(),
        recentTimes: groups.buffer(msg.groupId).map((x) => x.t),
        interjectTimes: groups.interjectTimes(msg.groupId),
        botReplyTimes: groups.speakTimes(msg.groupId),
      })
      if (hooks?.groupDecide) {
        try {
          const next = await hooks.groupDecide(decision, { msg, policy: pol, recentTexts, memScore })
          if (next && typeof next === 'object') Object.assign(decision, next)
        } catch (error) {
          log.warn('扩展模块改群聊决定出错：', error.message)
        }
      }
      if (!decision.reply) {
        log.debug(`群 ${msg.groupId}：不回（${decision.reason}）`)
        logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
        // 已经有一段在等她回：这条也算进去（她回的时候能看到），但不单独再触发一次
        if (pending.has(msg.chatId)) await addGroupImages(msg)
        return
      }
      // 鱼群保护：同一个群里同类 bot 太多时本轮不参与（移植自 surfcore 的 fish-guard）。
      // 放在「决定要说话」之后才算 —— 本来就决定不说的群（插话关着）不该白算、也不该刷日志。
      try {
        const fg = normalizeFishGuard(cfg.group?.fishGuard || {})
        if (fg.enabled) {
          // pair 级对聊泉冷却（1.3.63，OpenClaw pair-budget 思路）：只算我和这一个对象的
          // 互相针对——已确认是鱼的 2 轮就停，陌生人 4 轮；冷却期内它说什么（包括 @ 我）
          // 都不交给模型，别人照常、主人完全豁免。风暴在成型前就掐，不等全局占比报警。
          const ownerQQ = String(getConfig().ownerQQ || '')
          const pairKey = `${msg.groupId}:${msg.userId}`
          if (String(msg.userId) !== ownerQQ) {
            const calmUntil = pairCalmUntil.get(pairKey) || 0
            if (calmUntil > now) {
              log.info(`群 ${msg.groupId}：与 ${msg.nickname || msg.userId} 的对聊冷却中（${Math.ceil((calmUntil - now) / 60000)} 分钟），不回`)
              logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
              if (pending.has(msg.chatId)) await addGroupImages(msg)
              return
            }
            const pairMsgs = dedupConvo(groups.buffer(msg.groupId).filter((x) => x.uid && (x.self === true || String(x.uid) === String(msg.userId))).map((x) => ({
              sender: x.nick, userId: x.uid, time: x.t, isSelf: x.self === true,
            })))
            const loop = assessPairLoop(pairMsgs, String(msg.userId), { guard: fg })
            if (loop.blocked) {
              pairCalmSweep(now)
              pairCalmUntil.set(pairKey, now + fg.pairCooldownMs)
              log.info(`群 ${msg.groupId}：和 ${msg.nickname || msg.userId} 已经互来回 ${loop.rounds} 轮${loop.isFish ? '（名单里的鱼）' : ''}，${Math.round(fg.pairCooldownMs / 60000)} 分钟内不再接它的话`)
              logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
              if (pending.has(msg.chatId)) await addGroupImages(msg)
              return
            }
          }
          const direct = decision.mode === 'must'
          const density = assessFishDensity(groups.buffer(msg.groupId).map((x) => ({
            sender: x.nick, userId: x.uid, time: x.t, isSelf: x.self === true,
          })), { now, guard: fg, groupId: msg.groupId })
          if (density.blocked) {
            // 「被直接叫到就豁免」只对人类有效：叫人的这只本身是鱼（fishIds/名字判定）时
            // 豁免失效——不然两只 bot 互相 @ 就是无限对聊泉（2026-11-06 实测：麦麦系 bot
            // 「洛小雨」已在鱼名单，仍靠连续 @ 把她从冷却里一次次捞出来聊了十分钟）。
            const callerIsFish = senderFish({ userId: msg.userId, sender: msg.nickname }, fg)
            if (!(direct && fg.bypassDirectAddress && !callerIsFish)) {
              log.info(`群 ${msg.groupId}：${fishGuardReasonText(density)}${direct && callerIsFish ? '，叫她的也在鱼名单里，豁免不适用' : ''}，本轮不参与`)
              logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
              if (pending.has(msg.chatId)) await addGroupImages(msg)
              return
            }
            log.debug(`群 ${msg.groupId}：${fishGuardReasonText(density)}，但被直接叫到 → 只回一句`)
          }
        }
      } catch (error) { log.debug('鱼群保护判定出错：', error.message) }
      groupEntry.direct = Boolean(msg.messageId && msg.messageId !== '0' && msg.userId && (msg.mentioned || quotedBot))
      mode = decision.mode
      log.info(`群 ${msg.groupId}：${decision.reason} → 交给她`)
    }

    // 拼文案
    let text = msg.text
    if (msg.forwards?.length) {
      text = await expandForwards(msg, text)
      if (msg.kind === 'group') {
        const last = groups.lastFrom(msg.groupId, msg.userId)
        if (last) last.text = text
      }
    }
    const voiceText = cfg.voice.asr && msg.records.length ? await transcribe(msg) : msg.records.length ? '[发来一条语音]' : ''
    if (voiceText) text = (text ? text + ' ' : '') + voiceText
    if (voiceText && msg.kind === 'group') {
      // 群消息的文字在群聊缓冲里，语音转出来的字补进去，拼提示词时才看得到
      const last = groups.lastFrom(msg.groupId, msg.userId)
      if (last) last.text = text
    }
    // 引用消息：私聊现在就把被引用的内容取出来拼进正文；群聊留给 groupPrompt 懒加载（没交给她就白取）
    const quoted = msg.kind === 'private' && msg.replyId ? await quotedInfo(msg.replyId, msg) : null
    // 群聊：不在这里拼文案。等这段消息攒齐了（或她回完上一段），flush 时把群里新来的话一次性交给她
    const content = msg.kind === 'group' ? [] : [{ type: 'text', text: `【私聊】${msg.nickname}(${msg.userId})：` + (text || '（没有文字）') + (quoted ? '\n' + quoteInline(quoted) : '') }]
    const { images: imgs, failed: imgsFailed } = await imagesOf(msg)
    if (imgs.length) {
      // 模型明确不支持看图：硬塞图片块会让整轮请求被拒（她就一个字都回不了）。
      // 配了辅助看图模型就请它转述成文字，没配才退回一句说明。
      if ((await canSeeImages(dsh, cfg)) === false) {
        const note = await imageTextFor(imgs, msg.nickname, cfg, text)
        // 群聊的正文统一由 groupPrompt 从缓冲里拼，这里若 push 进 content 会和那段重复一遍；
        // 所以群聊挂到那条消息上，私聊才直接 push。
        if (msg.kind === 'group' && groupEntry) groupEntry.picNote = note
        else content.push({ type: 'text', text: note })
        log.debug(`模型不支持看图：${msg.chatId} 的 ${imgs.length} 张图已转成文字`)
      } else {
        for (let i = 0; i < imgs.length; i++) content.push({ type: 'image', data: imgs[i].data, mediaType: imgs[i].mediaType, name: `qq-${msg.messageId}-${i + 1}` })
      }
    }
    // 有图但没取成（下载失败 / 认不出格式）：别让她以为对方没发东西
    if (imgsFailed) {
      content.push({ type: 'text', text: `（${msg.nickname} 还发了 ${imgsFailed} 张图片，但没取下来，你看不到。如果这轮要靠图才能答，就说你没看清，让对方再发一次）` })
      log.info(`${msg.chatId} 有 ${imgsFailed} 张图片没取下来，已告知模型`)
    }
    // 引用里的图 / 表情包也给她看（最多 2 张，总数不超过 4；看不了图的模型靠上面的文字说明）
    if (quoted?.ok && (quoted.images.length || quoted.stickers.length) && imgs.length < 4) {
      const qImgs = await quoteImages(quoted, Math.min(2, 4 - imgs.length))
      for (const c of qImgs) content.push(c)
    }
    // 文件：取下来，文本类直接当正文给她读，二进制存盘只给路径
    if (msg.files?.length) {
      const files = await filesOf(msg)
      content.push(...inboundFileBlocks(files, msg.nickname))
      if (files.length) log.info(`${msg.chatId} 收到 ${files.length} 个文件：` + files.map((f) => f.name).join('、'))
    }
    logChat(msg.chatId, msg.nickname, text, msg.userId)
    lastChatAt = now
    if (msg.kind === 'private' && msg.userId === cfg.ownerQQ) lastOwnerChatAt = now
    onActivity?.({ kind: 'in', chatId: msg.chatId, userId: msg.userId, nickname: msg.nickname, text, direct: msg.kind === 'private' || msg.mentioned || mode === 'must', owner: isOwner(cfg, msg.userId) })

    if (opts.backfill) {
      content.unshift({
        type: 'text',
        text: backfillNoticeBlock({ gapMs: opts.gapMs || 120_000, count: 1, earliestAgeMs: opts.earliestAgeMs || 0 })
      })
    }

    enqueue({ chatId: msg.chatId, kind: msg.kind, userId: msg.userId, groupId: msg.groupId, nickname: msg.nickname }, content, msg.userId, wantsVoice(msg.text), mode, { stickerPick })
  }

  /** 把消息里的「[合并转发]」换成里面的聊天记录（最多 40 条，嵌套的转发不再展开）。 */
  async function expandForwards(msg, text) {
    let out = text
    for (const id of msg.forwards.slice(0, 2)) {
      let lines = []
      try {
        const r = await onebot.call('get_forward_msg', { id }, { timeoutMs: 15000 })
        for (const node of (r?.messages || []).slice(0, 40)) {
          const who = node.sender?.card || node.sender?.nickname || String(node.sender?.user_id ?? node.user_id ?? '某人')
          const m = parseMessageEvent({ message_type: 'private', user_id: node.sender?.user_id ?? node.user_id, message: node.message ?? node.content ?? [] }, selfId, { faceName: faces.nameOf })
          lines.push(`  ${who}：${(m.text || '（图片/表情）').slice(0, 120)}`)
        }
      } catch (error) {
        log.debug('拉合并转发失败：', error.message)
      }
      const body = lines.length ? `[合并转发的聊天记录（${lines.length} 条）]\n${lines.join('\n').slice(0, 2000)}\n[转发结束]` : '[合并转发（内容没拉到）]'
      out = out.replace('[合并转发]', body)
    }
    return out
  }

  // ---------- 戳一戳 ----------
  /** 有人戳了她：当成一条对她说的话交给她（群里也一定回），同一个聊天 20 秒内只算一次。 */
  async function onPoke(ev) {
    const self = String(ev.self_id || selfId || getConfig().botQQ)
    if (String(ev.target_id) !== self) return
    if (hooks?.poke) {
      try { if (await hooks.poke(ev)) return } catch (error) {}
    }
    const group = ev.group_id ? String(ev.group_id) : ''
    const poker = String(group ? ev.user_id : ev.sender_id ?? ev.user_id)
    if (!poker || poker === self) return
    const chatId = group ? `group:${group}` : `private:${poker}`
    interaction.rememberPoker(chatId, poker)
    if (!interaction.claimPoke(chatId)) return // 同一个聊天 20 秒内只算一次
    let nickname = poker
    try {
      const info = group ? await onebot.call('get_group_member_info', { group_id: Number(group), user_id: Number(poker) }, { timeoutMs: 5000 }) : await onebot.call('get_stranger_info', { user_id: Number(poker) }, { timeoutMs: 5000 })
      nickname = info?.card || info?.nickname || poker
    } catch (error) {}
    log.info(`${chatId}：${nickname} 戳了戳她`)
    await onMessage({
      post_type: 'message', message_type: group ? 'group' : 'private', sub_type: group ? 'normal' : 'friend',
      self_id: Number(self), user_id: Number(poker), ...(group ? { group_id: Number(group) } : {}), message_id: 0,
      sender: { user_id: Number(poker), nickname, card: nickname },
      message: [{ type: 'at', data: { qq: self } }, { type: 'text', data: { text: ` [戳了戳你${ev.action ? '：' + ev.action + (ev.suffix || '') : ''}]` } }],
    })
  }

  /** 没触发回复的群消息带的图：如果正有一段在等她回，把图也带上（最多 4 张）。 */
  async function addGroupImages(msg) {
    const p = pending.get(msg.chatId)
    if (!p) return
    try {
      const { images: imgs } = await imagesOf(msg)
      if (!imgs.length) return
      // 模型看不了图：以前这里直接 return，图被无声吞掉，她根本不知道群里有人发了图。
      // 现在配上辅助看图模型就转述成文字挂在这段待回上，没配也至少留一句「有人发了图」。
      if ((await canSeeImages(dsh, getConfig())) === false) {
        const nick = msg.nickname || msg.userId
        const note = await imageTextFor(imgs, nick, getConfig(), msg.text)
        // 挂到群里那条消息上，groupPrompt 拼这一段时会原样带出来
        const buf = groups.buffer(msg.groupId)
        const hit = buf.findLast?.((x) => String(x.uid) === String(msg.userId) && !x.fed)
        if (hit) hit.picNote = note
        else buf.push({ t: Date.now(), uid: msg.userId, nick, text: '', picNote: note })

        log.debug(`群 ${msg.chatId}：${imgs.length} 张图看不了，已转成文字备注`)
        return
      }
      if (p.images.length >= 4) return
      for (let i = 0; i < imgs.length && p.images.length < 4; i++) p.images.push({ type: 'image', data: imgs[i].data, mediaType: imgs[i].mediaType, name: `qq-${msg.messageId}-${i + 1}` })
    } catch (error) {}
  }

  /** 群聊这一段的提示词：之前的几句当背景，上次交给她之后群里新说的话全部列出来，让她看完整段再回。 */
  async function groupPrompt(chat, mode, imageRoom = 0) {
    const name = await groupName(chat.groupId)
    const buf = groups.buffer(chat.groupId)
    // 时间戳可能同一毫秒：直接取上一轮之后的消息，避免紧接着到达的消息丢失。
    const fresh = buf.filter((x) => !x.fed).slice(-20)
    const older = buf.filter((x) => x.fed).slice(-8)
    for (const x of buf) x.fed = true
    // 引用内容只在这一段真要交给她时才取（缓存在 quoteCache 里，取失败也会记一笔）
    const need = fresh.filter((x) => x.replyId && !('quote' in x))
    if (need.length) {
      const infos = await Promise.all(need.map((x) => quotedInfo(x.replyId, chat)))
      need.forEach((x, i) => { x.quote = infos[i] })
    }
    // 主人在群里说话时不带真实号码：只标「主人」，否则别人能从提示词里读到号码。
    // 她想 @ 主人用群名片就行（expandMentions 能对上），不需要号码。
    const ownerQQ = String(getConfig().ownerQQ || '')
    const whoOf = (x) => (ownerQQ && String(x.uid) === ownerQQ ? '主人' : `${x.nick}(${x.uid})`)
    // 每条消息标「（2 小时前）」这类相对时间：不然她眼里的历史和「刚刚」没区别
    const nowAt = Date.now()
    const line = (x) => `${whoOf(x)}${x.at ? '@了你' : ''}${agoLabel(x.t, nowAt)}：${x.text || '（图片/表情）'}${x.quote ? ' ' + quoteInline(x.quote) : ''}${x.picNote ? '\n    ' + x.picNote : ''}`
    // 新消息带编号，她想专门回某一条时可以引用；编号 → QQ 消息 ID 记下来，发的时候换成引用
    const refs = {}
    const numbered = fresh.map((x, i) => {
      if (x.mid && x.mid !== '0') refs[i + 1] = { mid: x.mid, uid: x.uid }
      return `[${i + 1}] ${line(x)}`
    })
    groups.setRefs(chat.groupId, refs)
    const query = fresh.map((x) => x.text).filter(Boolean).join('\n')
    const speakers = [...new Set(fresh.map((x) => String(x.uid)).filter(Boolean))]
    const hint = mode === 'interject' ? '（没人叫你。只有你对这个话题真有话说、能自然接上时才插一句：接着话题说，别突然开新话题；接不上就只回 [沉默]）'
      : mode === 'engaged' ? '（你刚才在参与这个话题。想接着聊就接着说，话题和你没关系了或没什么可说的就只回 [沉默]）'
      : '（有人在叫你，看完这一段再回）'
    const head = nowLine(nowAt, markTurnAt(chat.chatId), { what: '上一段消息' })
    const text = (older.length ? `【群聊 ${name}】之前在聊：\n${older.map(line).join('\n')}\n\n` : '') +
      `【群聊 ${name}】刚才新说的（${fresh.length} 条）${hint}\n${head}\n${numbered.join('\n')}\n\n` +
      '把这一段当成整体来回：一般说一两句就好，回给最需要回的那个人或者整个话题，不要一条一条地挨个回。\n' +
      '大多数时候直接说就行。只有想专门接其中某一条、而直接说别人会看不出你在回谁时（比如那条已经被后面的话刷上去了、或者你在回某个人随口一提的事），才在那句话开头写 <reply:编号>，会以「引用回复」发出；一次最多引用一条。\n' +
      '要 @ 某个人（对方会收到提醒），写 <at:QQ号>，QQ 号就是上面名字后面括号里的数字。'
    // 引用里的图 / 表情包：有空位就带上（最多 2 张）
    const quotedImages = []
    if (imageRoom > 0) {
      for (const x of fresh) {
        if (!x.quote?.ok || (!x.quote.images.length && !x.quote.stickers.length)) continue
        const take = Math.min(2, imageRoom - quotedImages.length)
        if (take <= 0) break
        quotedImages.push(...await quoteImages(x.quote, take))
      }
    }
    const direct = fresh.filter((x) => x.direct)
    const directSenders = new Set(direct.map((x) => x.uid))
    const target = directSenders.size === 1 ? direct.at(-1) : null
    const autoReply = target ? { mid: target.mid, uid: target.uid } : null
    return { text, query, speakers, autoReply, images: quotedImages }
  }

  // ---------- 连发合并：人常常一口气发好几句，等对方说完再一起交给她，别一句一回 ----------
  // 群聊再加一层：她正在回上一段时，新消息先攒着，等她说完再一起交给她（不会一条消息一轮、挨个回）
  const pending = new Map() // chatId → { chat, texts, images, senders, wantVoice, timer, firstAt, mode, count }
  // 活动状态（1.3.57）：busy（这一轮是否在跑 + 4 分钟卡住保护）与 typing（QQ「正在输入」计时器）。
  // 卡住保护从此只有一处实现，新写的调用点不会忘记判超时。
  const activity = createActivityState({ onTypingPing: () => {} })
  const isBusy = (chatId) => activity.isBusy(chatId)
  const RANK = { engaged: 1, interject: 2, must: 3 }
  const running = new Set() // chatId → 这一轮还在跑（模型 / 工具还没结束，turn/end 之前）；私聊此时新消息直接 steer 进去

  function enqueue(chat, content, senderId, wantVoice, mode = 'must', extra = {}) {
    const m = getConfig().merge
    const p = pending.get(chat.chatId) || { chat, texts: [], images: [], senders: new Set(), wantVoice: false, timer: null, firstAt: Date.now(), mode, count: 0 }
    p.chat = chat
    p.count++
    if ((RANK[mode] || 3) > (RANK[p.mode] || 3)) p.mode = mode
    for (const c of content) {
      if (c.type === 'text') p.texts.push(c.text)
      else if (c.type === 'image' && p.images.length < 4) p.images.push(c)
    }
    if (extra.stickerPick) p.stickerPick = (p.stickerPick || 0) + extra.stickerPick
    if (senderId) p.senders.add(String(senderId))
    p.wantVoice = p.wantVoice || wantVoice
    pending.set(chat.chatId, p)
    clearTimeout(p.timer)
    if (!m.enabled) return flush(chat.chatId)
    // 群里大家一来一回说得慢，多等一会儿把一段话攒齐
    const group = chat.kind === 'group'
    const wait = (group ? m.groupWaitSec : m.waitSec) * 1000
    const max = (group ? m.groupMaxSec : m.maxSec) * 1000
    const left = Math.max(0, max - (Date.now() - p.firstAt))
    p.timer = setTimeout(() => flush(chat.chatId), Math.min(wait, left))
    p.timer.unref?.()
  }

  async function flush(chatId) {
    const p = pending.get(chatId)
    if (!p) return
    clearTimeout(p.timer)
    // 「她挑」的提示统一在这里补：私聊、群聊、插话三条路都要带上
    const hint = p.stickerPick ? '\n\n' + stickerHint(p.stickerPick) : ''
    // 私聊：她这一轮还在跑（想 / 调工具），新消息直接 steer 进当前这一轮，像在 DSH 界面里插话一样（#7）
    if (isBusy(chatId) && p.chat.kind === 'private' && running.has(chatId)) {
      pending.delete(chatId)
      if (p.count > 1) log.info(`${chatId}：合并了 ${p.count} 条消息一起插给她`)
      const content = [{ type: 'text', text: p.texts.join('\n') + hint }, ...p.images]
      const query = p.texts.map((t) => t.replace(/^【私聊】[^：]*：/, '')).join('\n')
      const [first, ...rest] = [...p.senders]
      try {
        await pushToSession(p.chat, content, first, { wantVoice: p.wantVoice, extraSenders: rest, queryText: query, steer: true })
      } catch (error) {
        bump('errors')
        log.error(`插话进 DSH 失败（${chatId}）：`, error.message)
      }
      return
    }
    // 她还在回上一段：先攒着，回完了再交（release 会叫 flush）
    if (isBusy(chatId)) {
      p.waiting = true
      return
    }
    pending.delete(chatId)
    if (p.count > 1) log.info(`${chatId}：合并了 ${p.count} 条消息一起交给她`)
    let content
    if (p.chat.kind === 'group') {
      const gid = p.chat.groupId
      if (p.mode === 'interject') {
        groups.noteInterject(gid)
      }
      const gp = await groupPrompt(p.chat, p.mode, Math.max(0, 4 - p.images.length))
      if (gp.speakers.length) interaction.rememberSpeaker(chatId, [...p.senders].pop() || gp.speakers.at(-1))
      content = [{ type: 'text', text: gp.text + hint }, ...p.images, ...(gp.images || [])]
      p.query = gp.query
      p.speakers = gp.speakers
      p.autoReply = gp.autoReply
    } else {
      // 时间锚放在「【私聊】某某(QQ号)：」这行下面（不是最顶上）：
      // 来源那行仍然是每条消息的第一行，插件里所有认 /^【私聊/ 的地方都不受影响。
      const head = nowLine(Date.now(), markTurnAt(chatId))
      const joined = p.texts.join('\n').replace(/^(【私聊】[^：]*：)/, `$1\n${head}\n`)
      content = [{ type: 'text', text: joined + hint }, ...p.images]
    }
    activity.markBusy(chatId)
    try {
      const [first, ...rest] = [...p.senders]
      // 私聊：检索记忆时去掉「【私聊】某某(QQ)：」这个头
      const query = p.query ?? p.texts.map((t) => t.replace(/^【私聊】[^：]*：/, '')).join('\n')
      await pushToSession(p.chat, content, first, { wantVoice: p.wantVoice, extraSenders: rest, queryText: query, speakers: p.speakers, autoReply: p.autoReply })
    } catch (error) {
      release(chatId)
      bump('errors')
      log.error(`转进 DSH 失败（${chatId}）：`, error.message)
    }
  }

  /** 她这一轮说完了（或者没说）：放开，把这期间攒下的消息交给她。 */
  function release(chatId) {
    activity.release(chatId)
    running.delete(chatId)
    const p = pending.get(chatId)
    if (p && p.waiting) {
      p.waiting = false
      flush(chatId).catch(() => {})
    }
  }

  async function admit(agent, content) {
    if (content.length === 1) return content
    const att = dsh.attachments || dsh.get('attachments')
    if (att && typeof att.admitPromptContent === 'function') {
      try {
        return await att.admitPromptContent(content)
      } catch (error) {
        // 登记附件失败：DSH 适配层只认 attachmentId，裸 base64 会抛
        // Cannot read properties of undefined (reading 'attachmentId')，所以不能原样返回图片。
        // 退回纯文字，交给 imageTextFor/textForBlindModel 如实说明看不到。
        // 线上 EACCES 根因由 fnos-fsync-patch.js 在插件启动时修好，正常不会再走到这里。
        log.warn('图片没登记成附件，本轮按看不了图处理：', error.message)
        return [{ type: 'text', text: (content.find((c) => c && c.type === 'text') || {}).text || '' }]
      }
    }
    return content
  }

  // 私聊里等她回复时，在 QQ 上显示「对方正在输入…」（模型慢的时候让人知道她在想）。
  // 计时器与上限住在 activity-state.js，这里只把「怎么 ping」注入进去（模块不碰 onebot）。
  const pingTyping = (userId) => onebot.call('set_input_status', { user_id: Number(userId), event_type: 1 }, { timeoutMs: 5000 }).catch(() => {})
  function startTyping(key, chat) { activity.startTyping(key, chat, getConfig(), pingTyping) }
  function stopTyping(key) { activity.stopTyping(key) }

  async function pushToSession(chat, content, senderId, opts = {}) {
    const { agent, sessionId } = await agentFor(chat)
    const key = sessionKey(sessionId)
    const st = turnState.get(key) || { lastTurn: -1, text: '', senders: new Set() }
    // 上一句也带上：相关记忆检索遇到「嗯嗯」这种短句时，用上一句一起找（#79 之后由模块在提示词里加）
    const prevText = st.lastText || st.prevText || ''
    if (hooks?.prompt) {
      try {
        const next = await hooks.prompt(content, { chat, sessionId, senderId, prevText, ...opts })
        if (next === null) {
          log.info(`${chat.chatId}：扩展模块决定这次不交给她`)
          if (!opts.steer) release(chat.chatId) // 插话被拦下时，当前这一轮还在跑，不能放开
          return
        }
        if (Array.isArray(next)) content = next
      } catch (error) {
        log.warn('扩展模块改提示词出错：', error.message)
      }
    }
    const earlier = interaction.takeAside(chat.chatId)
    if (earlier.length) {
      const lines = earlier.map((x) => `${new Date(x.at).toTimeString().slice(0, 5)} 你：${x.text}`)
      content = [{ type: 'text', text: `【你之前在这个聊天里主动说过（是在别处安排下发的，这里的人都看到了）】\n${lines.join('\n')}\n` }, ...content]
    }
    // 这一轮还在跑、这句是排队给下一轮的：额外记到 pendingSenders，等上一轮 turn/end 时接过去（#90）
    // ⚠ 不能用 busy：flush 一开始就把 busy 置上了，否则会把这一批自己的说话人塞进下一轮，
    //    主人和群友混在一起会让「仅主人」判断误拒（sticker-owner 回归抓到过）。
    const queuedNextTurn = !opts.steer && running.has(chat.chatId)
    const addSender = (u) => {
      st.senders.add(String(u))
      if (queuedNextTurn) {
        if (!st.pendingSenders) st.pendingSenders = new Set()
        st.pendingSenders.add(String(u))
      }
    }
    if (senderId) addSender(senderId)
    for (const s of opts.extraSenders || []) addSender(s)
    // 上一句也留着：这一句太短（「嗯嗯」「然后呢」）时一起拿去想起相关的事
    if (st.lastText) st.prevText = st.lastText
    st.lastText = String(opts.queryText ?? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')).slice(-600)
    st.speakers = opts.speakers || (senderId ? [String(senderId), ...(opts.extraSenders || []).map(String)] : [])
    if (opts.wantVoice) st.wantVoice = true
    if (!opts.steer) st.autoReply = opts.autoReply || null
    turnState.set(key, st)
    const admitted = await admit(agent, content)
    startTyping(key, chat)
    const message = { id: randomUUID(), role: 'user', content: admitted, source: { kind: SOURCE_KIND } }
    // 正在跑的这一轮：steer = 下一步就看到这句（DSH 界面插话走的也是它）；空闲时照旧 followup 开新一轮
    if (opts.steer && typeof agent.steer === 'function') {
      log.info(`${chat.chatId}：她还在忙，这句直接插进当前这一轮（steer）`)
      await agent.steer(message)
    } else {
      running.add(chat.chatId)
      await agent.followup(message)
    }
    try {
      if (dsh.sessions && typeof dsh.sessions.flush === 'function') await dsh.sessions.flush(agent.session)
    } catch (error) {}
  }

  /** 后台任务（写日记、主动搭话的草稿）：在专用会话里跑一轮，拿到正文但不自动转发。
   *  key：同一个模块有**多种**后台用途时用来分会话（避免两种用途的提示词混进同一段上下文）——
   *  不带 key 走 `<name>` 那条（向后兼容，老会话继续复用），带 key 走 `<name>:<key>`，
   *  于是工作区里各自一条会话、进度互不阻塞，也不会把两种提示词混进同一段上下文。 */
  async function runSystemTurn(name, title, prompt, { timeoutMs = 180000, noTools = false, key: scope = '' } = {}) {
    const suffix = String(scope || '').trim().replace(/[^\w:-]/g, '').slice(0, 32)
    const chat = { chatId: suffix ? `system:${name}:${suffix}` : `system:${name}`, kind: 'system', title, noTools: !!noTools }
    const { agent, sessionId } = await agentFor(chat)
    const key = sessionKey(sessionId)
    const st = turnState.get(key) || { lastTurn: -1, text: '', senders: new Set() }
    if (st.system) throw new Error('这个后台会话的上一轮还没结束')
    turnState.set(key, st)
    let timer
    const result = new Promise((resolve, reject) => {
      st.system = { resolve, reject }
      timer = setTimeout(() => {
        if (st.system) st.system = { resolve() {}, reject() {} }
        reject(new Error('等太久了'))
      }, timeoutMs)
    }).finally(() => clearTimeout(timer))
    // followup 有的宿主一直等到整轮结束才返回；不能先 await 它，否则超时 Promise 会悬空。
    // 超时后的系统会话仍保留标记，晚到的结果只丢弃，绝不误发到 QQ。
    const system = st.system
    Promise.resolve().then(() => agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: SOURCE_KIND } })).catch((error) => {
      if (st.system === system) { st.system = null; system.reject(error) }
    })
    return result
  }

  /** 这一轮里说话的人是不是全是主人（群管等敏感工具用）。 */
  /** 这一轮里主人说过话（群里常有别人插话，不要求每条都是主人）。 */
  // 主人私聊里只可能是主人说话：就算这一轮的记录丢了（工具是旧闭包、排队轮次被上一轮 turn/end 清掉等，见 #90），
  // 「仅主人」也应当放行；群聊 / 别人私聊不放宽。
  function ownerPrivateChat(sessionId) {
    try {
      const chatId = chatOfSession(sessionId) || resolveChatOfSession?.(sessionId) || ''
      return chatId === `private:${getConfig().ownerQQ}`
    } catch (error) { return false }
  }

  function turnHasOwner(sessionId) {
    const st = turnState.get(sessionKey(sessionId))
    if (st && st.directOwner) return true // 主人在 DSH 面板里直接打字
    if (st && [...st.senders].some((u) => isOwner(getConfig(), u))) return true
    return ownerPrivateChat(sessionId)
  }

  function turnSendersAllOwner(sessionId) {
    const st = turnState.get(sessionKey(sessionId))
    if (st && st.directOwner) return true // 主人在 DSH 面板里直接打字
    if (!st || !st.senders.size) return ownerPrivateChat(sessionId)
    return [...st.senders].every((u) => isOwner(getConfig(), u))
  }

  function turnHasUniqueImageGenOwnerRequester(sessionId, requests = []) {
    const st = turnState.get(sessionKey(sessionId))
    const chatId = chatOfSession(sessionId) || resolveChatOfSession?.(sessionId) || ''
    if (!chatId.startsWith('group:') || !st || st.directOwner) return false
    const senders = new Set([...(st.senders || [])].map(String))
    const query = String(st.lastText || '')
    const requesters = new Set()
    for (const request of requests || []) {
      const uid = String(request?.userId || '')
      const text = String(request?.text || '').trim()
      if (uid && senders.has(uid) && text && query.includes(text)) requesters.add(uid)
    }
    return requesters.size === 1 && isOwner(getConfig(), requesters.values().next().value)
  }

  function chatOfSession(sessionId) {
    const key = sessionKey(sessionId)
    const live = sessionToChat.get(key)
    if (live) return live
    // 重启后会话还没被第一条消息唤醒时，内存映射是空的：退回持久化的 聊天→会话 映射（#90 兜底要用）
    try {
      for (const [chatId, entry] of Object.entries(map().chats || {})) {
        if (entry && entry.sessionId && sessionKey(entry.sessionId) === key) return chatId
      }
    } catch (error) {}
    return ''
  }

  /** 只让一个聊天重新开始：归档它的会话，下一条消息开新会话。 */
  function resetChat(chatId) {
    questions.cancel(chatId, '会话重新开始')
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    const m = map()
    const e = m.chats[chatId]
    if (!e) return false
    Promise.resolve(reg?.archiveSession?.(e.sessionId)).catch((error) => log.debug('归档会话失败：', error.message))
    const k = sessionKey(e.sessionId)
    sessionToChat.delete(k)
    turnState.delete(k)
    const prev = mounted.get(k)
    if (prev) {
      for (const off of prev.offs) { try { if (typeof off === 'function') off() } catch {} }
      mounted.delete(k)
    }
    delete m.chats[chatId]
    saveMap(m)
    log.info(`${chatId} 重新开始`)
    return true
  }

  /** 重新开始：把现有的 QQ 会话都归档（侧栏里还能找回），下一条消息起开新会话。 */
  function resetSessions() {
    approvals.clear('会话重置')
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    const m = map()
    let n = 0
    for (const [chatId, e] of Object.entries(m.chats)) {
      try {
        // 可能返回 Promise：必须接住 rejection，未处理的 rejection 会让 DSH 宿主退出
        Promise.resolve(reg?.archiveSession?.(e.sessionId)).catch((error) => log.debug('归档会话失败：', error.message))
      } catch (error) {
        log.debug('归档会话失败：', error.message)
      }
      const k = sessionKey(e.sessionId)
      sessionToChat.delete(k)
      turnState.delete(k)
      const prev = mounted.get(k)
      if (prev) {
        for (const off of prev.offs) { try { if (typeof off === 'function') off() } catch {} }
        mounted.delete(k)
      }
      delete m.chats[chatId]
      n++
    }
    // 专用工作区里其他零散的会话（比如手动点「新会话」留下的空白会话）也一起归档
    try {
      const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
      const ws = (reg?.list?.() || []).find((w) => norm(w.path) === norm(workspaceDirOf(getConfig())))
      for (const sid of ws?.sessionIds || []) {
        if ((reg.archivedSessionIds || []).includes(sid)) continue
        Promise.resolve(reg.archiveSession(sid)).catch(() => {})
        n++
      }
    } catch (error) {}
    saveMap(m)
    log.info(`重新开始：归档了 ${n} 个 QQ 会话`)
    return n
  }

  /** 模拟测试：fn 里发出去的消息都记下来不真发，返回 { result, sent }。 */
  async function capture(fn) {
    const sent = []
    const result = await captureStore.run(sent, fn)
    return { result, sent }
  }
  function captureOnly(chatId, message, note) {
    const cap = captureStore.getStore()
    if (!cap) return null
    cap.push({ chatId, note, message })
    return { message_id: 'sim-' + cap.length }
  }
  /** 模拟测试：假装这个会话这一轮是谁在说话（工具里的「主人才能用」靠它判断）。 */
  function simulateTurn(sessionId, senders) {
    turnState.set(sessionKey(sessionId), { lastTurn: -1, text: '', senders: new Set(senders.map(String)) })
  }

  /**
   * 把面板里配的模型**立刻**应用到所有已有的 QQ 会话。
   *
   * 平时改完配置要等对方发下一条消息才切（ensureSession 里比对 m.chats[chatId].model），
   * 冷群可能几小时都不动 —— 主人看到的就是「配了没生效，得去 DSH 会话里手动换」。
   * 这里主动遍历一遍，把差异一次性抹平。
   * @returns {Promise<{applied:number, skipped:number, failed:number, detail:Array}>}
   */
  async function syncAllModels() {
    const m = map()
    const detail = []
    let applied = 0
    let skipped = 0
    let failed = 0
    for (const [chatId, entry] of Object.entries(m.chats || {})) {
      if (!entry || !entry.sessionId) { skipped += 1; continue }
      const kind = chatId.startsWith('group:') ? 'group' : chatId.startsWith('private:') ? 'private' : 'system'
      const chat = kind === 'group'
        ? { chatId, kind, groupId: chatId.slice(6) }
        : kind === 'private'
          ? { chatId, kind, userId: chatId.slice(8) }
          : { chatId, kind: 'system', noTools: true }
      try {
        const target = await resolveTarget(chat)
        const want = keyOf(target)
        if (!want) { skipped += 1; continue }
        if (entry.model === want) { skipped += 1; continue }
        const agent = await resolveAgent(entry.sessionId)
        if (!applyModel(agent, target)) { failed += 1; detail.push({ chatId, want, ok: false }); continue }
        entry.model = want
        applied += 1
        detail.push({ chatId, want, ok: true })
      } catch (error) {
        failed += 1
        detail.push({ chatId, ok: false, error: error.message })
        // 会话已经失效（归档/删了）：把映射删掉，让下一条消息按当前配置重建，
        // 否则它会一直挂在表里、每次都切不动，主人看到的就是「配了永远不生效」。
        if (/not found|不存在|已归档|no session/i.test(String(error.message || ''))) {
          delete m.chats[chatId]
          detail[detail.length - 1].dropped = true
        }
      }
    }
    const dropped = detail.filter((x) => x.dropped).length
    if (applied || dropped) {
      saveMap(m)
      if (applied) log.info(`按面板配置切换了 ${applied} 个会话的模型`)
      if (dropped) log.info(`${dropped} 个会话已失效，清掉映射让下次按新配置重建`)
    }
    return { applied, skipped, failed, dropped, detail }
  }

  return {
    // 仅关闭本中枢持有的短期媒体缓存，迟到的事件不能重新写入。
    disposeRecentMedia: () => recentMedia.dispose(),
    // 新核心旁路指令桥：审批与等待中的交互提问回答优先消费。
    interceptInteraction: ({ text, userId, chatId, who } = {}) => {
      try {
        if (approvals.handleReply(text, userId, chatId)) { logChat(chatId, who || '', text, userId); return true }
        if (questions.has(chatId) && questions.handleReply(chatId, text)) { logChat(chatId, who || '', text, userId); return true }
      } catch (error) { log.debug('旁路指令判定出错：', error.message) }
      return false
    },
    // PR-1（ADR-0002）：开旗态把非 hub 主链的发信转进 Outbox；关旗态透传 onebot.call。
    deliverRaw: (args = {}) => {
      const eg = egressRef?.current
      const chatKey = args.chatKey || (args.params?.group_id ? `group:${args.params.group_id}` : args.params?.user_id ? `private:${args.params.user_id}` : '')
      if (!eg) return onebot.call(args.action, args.params, args.opts)
      if (!chatKey) {
        log.warn(`egress：${args.action} 推断不出会话域，透传未入台账（待收口面）`)
        return onebot.call(args.action, args.params, args.opts)
      }
      return eg.deliver({ ...args, chatKey, receipt: args.receipt || 'required', sourceModuleId: args.sourceModuleId || 'module' })
    },
    modelFor: targetModel,
    syncAllModels,
    /** 这个聊天最近发来的图片 / 表情（新的在后面），可选只要某人发的 */
    recentMedia: (chatId, userId) => recentMedia.get(chatId, userId),
    stickerOf,
    capture,
    captureOnly,
    simulateTurn,
    onMessage,
    onPoke,
    onSessionEvent,
    rememberPoker: (chatId, uid) => interaction.rememberPoker(chatId, uid),
    claimPoke: (chatId) => interaction.claimPoke(chatId),
    rememberSpeaker: (chatId, uid) => interaction.rememberSpeaker(chatId, uid),
    wasSent: (messageId) => sentIds.has(String(messageId || '')),
    deliver,
    sendText,
    sendVoice,
    sendVoiceFile,
    sendFile,
    sendSticker,
    sendImage,
    sendSegments,
    pushToSession,
    runSystemTurn,
    turnSendersAllOwner,
    turnHasUniqueImageGenOwnerRequester,
    turnHasOwner,
    resetChat,
    /** 这个聊天她是不是正忙着一轮（在想 / 在跑工具 / 在发）：压缩、插话这类后台动作拿来避让。 */
    isBusy: (chatId) => activity.isBusy(chatId),
    joinTopic: (gid) => groups.joinTopic(gid),
    leaveTopic: (gid) => groups.leaveTopic(gid),
    chatOfSession,
    knownChats,
    canSeeImages: async (chat) => {
      const cfg = getConfig()
      if (cfg.model?.vision === 'on') return true
      if (cfg.model?.vision === 'off') return false
      const selected = targetModel(chat)
      return selected ? modelVision(dsh, selected.provider, selected.model) : null
    },
    resetSessions,
    questions,
    approvals,
    askUserQuestion: (chatId, req) => questions.ask(chatId, req),
    requestApproval: (req, opts) => approvals.request(req, opts),
    lastTextOf: (sessionId) => turnState.get(sessionKey(sessionId))?.lastText || '',
    prevTextOf: (sessionId) => turnState.get(sessionKey(sessionId))?.prevText || '',
    speakersOf: (sessionId) => turnState.get(sessionKey(sessionId))?.speakers || [],
    // 新核心登记本轮说话人（真机审计：新核心不经 pushToSession，turnState 一直是空的 →
    // memory.contextFor 取「正在说话的几个人」永远为空、turnHasOwner/turnSendersAllOwner 判定失真）
    noteTurnSenders: (sessionId, senders = [], opts = {}) => {
      try {
        const key = sessionKey(sessionId)
        const st = turnState.get(key) || { lastTurn: -1, text: '', senders: new Set() }
        const list = (senders || []).map(String).filter(Boolean)
        st.speakers = list
        st.senders = new Set(list)
        if (opts.queryText != null) {
          if (st.lastText) st.prevText = st.lastText
          st.lastText = String(opts.queryText).slice(-600)
        }
        if (opts.directOwner) st.directOwner = true
        turnState.set(key, st)
      } catch {}
    },
    /** 入站表情收集（新核心调；按 collectMode 决定收不收）。 */
    collectInboundSticker: async (seg, chatId) => {
      try {
        if (!getConfig().stickers?.enabled || !getConfig().stickers?.collect) return { ok: false, reason: '偷表情关着' }
        return await stickers.collect(seg, chatId)
      } catch (error) { return { ok: false, reason: String(error.message || error) } }
    },
    logChat,
    markTurnAt,
    localTranscribe,
    ensureWorkspace,
    chatLogOf,
    chatLogDays,
    deleteChatLog,
    sessions: () => map().chats,
    resolveTarget,
    groupName,
    stats: () => ({ ...stats }),
    // 真机审计 1.11：开旗后进站/出站都不走本文件，面板统计以前全 0。把计数入口与
    // 「最近发来的图/表情」登记入口公开给新核心（同一份内存状态，面板读的仍是 stats()）。
    bumpStats: (k) => { try { if (k in stats) bump(k) } catch {} },
    noteRecentMedia: (chatId, segs, userId) => {
      try {
        const items = (segs || []).filter((x) => x && ['image', 'mface', 'face'].includes(x.type))
        if (items.length) recentMedia.remember(String(chatId), items.map((seg) => ({ seg, userId: String(userId || ''), sticker: seg.type !== 'image' })))
      } catch {}
    },
    get lastChatAt() { return lastChatAt },
    get lastOwnerChatAt() { return lastOwnerChatAt },
    get lastBotToOwner() { return lastBotToOwner },
    get selfId() { return selfId },
    groupNames,
  }
}
