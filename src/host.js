// QQ Hub · 宿主半边（DSH 插件入口）—— 组合根
//
// 让 DSH 里的 AI 以独立 QQ 号「大肥鱼」住在 QQ 里：
//   SnowLuma（OneBot v11）⇄ 本插件 ⇄ DSH 会话（QQ Hub 自带的 preset + 人格）
// 面板在侧栏「自动化任务」下面（网页半边见 client/client.js），这里提供它要的 /qq-hub/api/* 接口。
//
// 本文件只做「装配」：创建各层、按顺序接线。分层（host.js 1.3.65 拆分，函数体逐字搬运）：
//   src/host/http.js            面板 HTTP 小工具（send/readBody/route…）
//   src/host/gateway.js         QQ 网关连接层（OneBot 客户端 + 登录核对 + 事件分发 + 补收）
//   src/host/models.js          DSH 模型目录（listModels + 缓存）
//   src/host/pipeline.js        RFC-0001 洋葱管道装配（FLAG_USE_PIPELINE 开启态）
//   src/host/effects.js         DSH 旁路 seam（审批流/交互提问/会话监听/看门狗）
//   src/host/panel/overview.js  面板聚合视图（overview/脱敏/连接诊断）
//   src/host/panel/routes-*.js  72 条面板路由按域拆分
// 业务能力本身都是模块（src/modules/）：表情、语音、记忆、空间、B 站、翻唱、生图……
// 能单独关掉，也能用自己写的替换。
//
// ⚠ 安全默认：总开关关、试运行开。不手动打开，一句都不会真的发到 QQ。

import { patchFnosFsync } from './core/fnos-fsync-patch.js'
patchFnosFsync() // 自动应用 fnOS 祖先目录耐久性同步容错，避免图片登记附件抛 EACCES

import { readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { loadConfig, saveConfig } from './core/config.js'
import { dataDir, readJson, writeJson } from './core/store.js'
import { createLogger } from './core/logger.js'
import { registerSecret } from './core/redact.js'
import { createSnowLumaManager } from './snowluma/manager.js'
import { createHub, workspaceDirOf } from './chat/hub.js'
import { createLocal } from './local/local.js'
import { createGroupRoles } from './chat/group-roles.js'
import { isStickerSegment } from './chat/inbound.js'
import { defaultModel, askModel } from './core/llm.js'
import { parseCommand, runCommand, createMutes } from './chat/commands.js'
import { listPersonas, readPersona, currentPersonaText, rulesText, seedPersonas, personaIdFor } from './persona/personas.js'
import { createModules, API_VERSION } from './core/modules.js'
import { createBridge } from './core/bridge.js'
import { createDangerGuard } from './security/danger.js'
import { BUILTINS } from './modules/index.js'
// RFC-0001 Phase 0（US-003）：遗留核心终端化 + FLAG_USE_PIPELINE 熔断开关
import { isPipelineEnabled, isModularCoreEnabled, unwrapPipelineError } from './kernel/legacy-fallback.js'
import { createSharedOutbox } from './host/shared-outbox.js'
import { createHubEgress } from './host/hub-egress.js'
import { isEgressShadowEnabled } from './kernel/ctx-store.js'
// RFC-0001 Phase 1（US-007）：出口切换——pipeline 开启时 hub 的发送全部收口 ctx.reply → Dispatcher
import { createEgressOnebot, createEgressSendHook } from './kernel/mw-egress-cutover.js'
// RFC-0001 Phase 3（US-010）：记忆装配接管（NEW_MEMORY_PIPELINE 灰度位）
import { createContextProviderTakeover, isNewMemoryPipelineEnabled } from './kernel/mw-memory.js'
// 分层后的装配件
import { createHttpKit } from './host/http.js'
import { createModelDirectory } from './host/models.js'
import { createGateway } from './host/gateway.js'
import { assemblePipeline } from './host/pipeline.js'
import { createModularCore } from './host/modular-core.js'
import { createModuleSendBridge } from './host/module-send-bridge.js'
import { createHostEffects } from './host/effects.js'
import { createPanelOverview } from './host/panel/overview.js'
import { registerConfigRoutes } from './host/panel/routes-config.js'
import { registerPurposeRoutes } from './host/panel/routes-purpose.js'
import { registerGatewayRoutes } from './host/panel/routes-gateway.js'
import { registerPersonaRoutes } from './host/panel/routes-persona.js'
import { registerModulesRoutes } from './host/panel/routes-modules.js'
import { registerMiscRoutes } from './host/panel/routes-misc.js'

export const name = 'qq-hub'
// 注意：不要把 userQuestions 写进 inject。
// cordis 4 的 Fiber._refresh() 会对 inject 里每个 key 做「实现必须存在」判定，
// 缺一个就把 epoch 设成 INACTIVE，插件永远不启动（这正是之前 /qq-hub/api/* 全 404 的根因）。
// userQuestions 在 0.2.2-alpha.2 运行时并不存在，所以只能运行时探测（见 host/effects.js）。
export const inject = ['agents', 'sessions', 'webServer', 'timer', 'workspaceRegistry', 'attachments', 'systemPrompt', 'llm']

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) } catch (error) { return { version: '?' } }
})()
const VERSION = PKG.version
// 模块工具代际：本实例内的自增号（热重载会新建实例，配合 mountedTools 的 Map 实现「整套重挂」）
let TOOLS_GEN = 1
const PREFIX = '/qq-hub/api'

export function apply(ctx) {
  const logger = createLogger({ dsh: ctx })
  const log = logger.child('core')
  let cfg = loadConfig()
  let mods = null
  let bridge = null
  let hub = null // 遗留核心：US-003 起作为管道终端（开关关闭时仍直调）
  let dangerGuard = null // 危险命令确认（security.dangerConfirm 开着才生效）
  const getConfig = () => cfg
  const secrets = () => { for (const k of ['webuiPassword', 'httpToken', 'wsToken']) registerSecret(cfg.snowluma[k]); registerSecret(cfg.imageGen.apiKey); registerSecret(cfg.bridge.token) }
  const setConfig = (next) => {
    const before = cfg
    cfg = saveConfig(next)
    // 改机器人号后旧连接的核对结果立刻失效，必须重新核对才能处理消息或完成向导。
    if (before.botQQ !== cfg.botQQ) {
      gatewayState.wrongAccount = ''
      if (gatewayState.onebotState === 'connected') onebot.restart()
    }
    secrets()
    if (bridge && before.bridge.dshTools !== cfg.bridge.dshTools) bridge.refresh()
    if (mods && (JSON.stringify(before.modules) !== JSON.stringify(cfg.modules) || before.safeMode !== cfg.safeMode)) mods.sync().catch(() => {})
    mods?.emit('config', cfg, before)
    return cfg
  }
  secrets()
  seedPersonas()

  // ---------- 人格与规则：通过提示词变量注入到 QQ Hub 的三个 preset ----------
  const variable = (n, fn) => ctx.effect(() => ctx.systemPrompt.variable(n, fn), `qq-hub: 变量 ${n}`)
  const rulesOpts = (kind) => (mods ? { off: mods.builtinOff(), extra: mods.rules(kind) } : {})
  // 扩展模块能整段改写人格和规则（同步：提示词变量不能等）
  const rewrite = (event, text, ...args) => { const r = mods ? mods.filterSync(event, text, ...args) : text; return typeof r === 'string' ? r : r === null ? '' : text }
  // 三个变量的取值函数抽出来复用：新核心按会话再注册一遍（热重载后宿主侧变量可能缺失，
  // 缺了就报 unknown prompt variable "{{qq_hub_rules_private}}" → 整轮直接 error）
  const promptVarText = {
    qq_hub_persona: () => rewrite('persona', currentPersonaText(cfg.persona.current)),
    qq_hub_rules_private: () => {
      const base = rewrite('rules', rulesText('private', cfg, rulesOpts('private')), 'private')
      // 危险命令确认开着时补一句：被拦下要如实告诉主人，别绕着写
      return base + (cfg.security && cfg.security.dangerConfirm
        ? '\n【危险命令】终端命令如果被安全策略拦下（删根目录/格式化/关机/下载后直接执行等），把命令原文和原因如实告诉主人，等主人回复「确认」后再重试；不要换一种写法绕过。'
        : '')
    },
    qq_hub_rules_social: () => rewrite('rules', rulesText('social', cfg, rulesOpts('social')), 'social'),
  }
  for (const [n, fn] of Object.entries(promptVarText)) variable(n, fn)

  // ---------- QQ 网关（连接层：SnowLuma + OneBot 状态机，见 host/gateway.js） ----------
  const snowluma = createSnowLumaManager({
    getConfig,
    log: logger.child('snowluma'),
    // 控制台密码由插件自动生成并保存，用户不用管
    savePassword: (pw, auto = true) => setConfig({ ...cfg, snowluma: { ...cfg.snowluma, webuiPassword: pw, passwordAuto: auto } }),
  })
  const endpoint = () => {
    const s = cfg.snowluma
    // 接自己的 OneBot 时只认填的地址；用 SnowLuma 时没填的从它的配置里读
    const auto = cfg.gateway === 'onebot' || (s.httpUrl && s.wsUrl) ? null : snowluma.endpoint()
    return {
      httpUrl: s.httpUrl || auto?.httpUrl || '',
      wsUrl: s.wsUrl || auto?.wsUrl || '',
      httpToken: s.httpToken || auto?.httpToken || '',
      wsToken: s.wsToken || auto?.wsToken || '',
    }
  }

  /** RFC-0001 熔断开关路由 + M4 模块化新核心总开关：
   *  FLAG_MODULAR_CORE 默认开（2026-11-09 转正，现网 .5-local5+3 验证树）→ 实时事件走新核心（Registry→Turn→Assembly→Outbox）；
   *  显式 false/0 逃生阀：否则 FLAG_USE_PIPELINE 开 → 洋葱管道；都关 → 直调遗留 hub（legacy 路径逐字不变）。 */
  function dispatchEvent (ev, kind) {
    const sink = (error) => log.error(kind === 'poke' ? '处理戳一戳出错：' : '处理消息出错：', (usePipeline ? unwrapPipelineError(error) : error).message)
    if (useModularCore && modularCoreApi) {
      const p = kind === 'poke' ? modularCoreApi.dispatchLegacyEvent(ev) : modularCoreApi.dispatchLegacyEvent(ev)
      p.catch(sink)
      return
    }
    if (usePipeline) pipelineApi.dispatchLegacyPipeline(ev).catch(sink)
    else if (kind === 'poke') hub.onPoke(ev).catch(sink)
    else hub.onMessage(ev).catch(sink)
  }
  const gateway = createGateway({
    getConfig, snowluma, endpoint, logger, log,
    getHub: () => hub, getMods: () => mods, getDangerGuard: () => dangerGuard,
    getModularCore: () => modularCoreApi,
    dispatch: dispatchEvent,
  })
  const { onebot } = gateway
  const gatewayState = gateway.state
  const groupRoles = createGroupRoles({ onebot, getConfig, log: logger.child('chat') })
  const local = createLocal({ getConfig, log: logger })
  const mutes = createMutes()
  const models = createModelDirectory({ ctx })

  // 聊天中枢找表情库、语音时，找的是当时在跑的那个模块；模块关着就当没有
  const use = (id) => mods?.use(id) || null
  const stickers = {
    match: (q) => use('stickers')?.match?.(q) ?? null,
    segmentFor: (it) => use('stickers')?.segmentFor?.(it) ?? null,
    markUsed: (md5) => use('stickers')?.markUsed?.(md5),
    pickForReply: (t) => use('stickers')?.pickForReply?.(t) ?? null,
    collect: async (s, chatId) => (use('stickers')?.collect ? use('stickers').collect(s, chatId) : { ok: false, reason: '表情包模块关着' }),
    library: () => use('stickers')?.library?.() ?? { items: [] },
  }
  const tts = {
    speak: async (text) => {
      const v = use('voice')
      if (!v?.speak) throw new Error('语音模块关着')
      return v.speak(text)
    },
  }

  // ---------- RFC-0001 Phase 1（US-007）：出口切换装配件（pipeline 开启态才注入） ----------
  // 关闭态（默认）：hub 拿到的还是原 onebot 客户端与原 hooks.send，旧路径逐字不动。
  // 开启态：两个注入点都在装配层，hub.js 零改动——
  //   hubOnebot   收口 send_group_msg / send_private_msg / upload_*_file
  //               （live 吞包入队、shadow 旧通道真发并记 hash）；
  //   hubSendHook 扩展模块改写语义不变，另记投递草稿（chatId/note/priority/delayMs）给出口认领。
  // FLAG_EGRESS_SHADOW=true → shadow 双算比对（先比对后切权），缺省 live。
  const usePipeline = isPipelineEnabled(process.env)
  const egressMode = usePipeline && isEgressShadowEnabled(process.env) ? 'shadow' : 'live'
  const hubOnebot = usePipeline
    ? createEgressOnebot({ onebot, mode: egressMode, log: logger.child('egress') })
    : onebot
  const hubSendHook = usePipeline
    ? createEgressSendHook({ legacySend: (message, info) => mods.filter('send', message, info), log: logger.child('egress') })
    : (message, info) => mods.filter('send', message, info)

  // ---------- RFC-0001 Phase 3（US-010）：记忆装配接管（NEW_MEMORY_PIPELINE 灰度位） ----------
  // 缺省关：contextProviders 仍是原函数本体的数组，与 US-009 逐字节等价（红线）。
  // 开（且仅当管道也开）：注入面**外面**包一层 takeover——ALS 有本轮 ctx、
  // mw-memory 已在 ctx.state 备好装配结果 → 直接供给 state 缓存，原 provider 零调用；
  // 任一条件不满足（flag off / 无 ctx / 中间件没跑到）→ 原 mods.contextFor（legacy 回退）。
  // hub.js 一行未动；接管面覆盖清单与已知边界（其余 api.context 模块 / 群 speakersOf 档案）
  // 见 src/kernel/mw-memory.js 头注。
  const baseContextProvider = (args) => mods.contextFor(args)
  const memoryAssemblyOn = usePipeline && isNewMemoryPipelineEnabled(process.env)
  const hubContextProviders = [
    memoryAssemblyOn
      ? createContextProviderTakeover({ provider: baseContextProvider, isNewPipeline: () => true, log: logger.child('memory-mw') })
      : baseContextProvider,
  ]

  // ---------- PR-1（ADR-0002）：Outbox 收口接线 ----------
  // 洋葱 pipeline 与共享 Outbox 可共存：Outbox 使用未包装的原 OneBot 客户端，不经过第二层包装。
  const useModularCore = isModularCoreEnabled(process.env)
  const egressRef = { current: null }
  const sharedOutbox = useModularCore
    ? createSharedOutbox({ onebot, getConfig, log: logger.child('outbox'), ledgerFile: dataDir('deliveries.json') })
    : null
  if (sharedOutbox) {
    egressRef.current = createHubEgress({ outbox: sharedOutbox, log: logger.child('egress') })
    log.info('PR-1 Outbox 收口：全仓主动发送接入统一出口（消息/文件/戳一戳/模块直调/说说；台账+试运行+泄露闸对全部出口生效）')
  }

  const sharedHooks = {
    message: (msg) => mods.claim('message', msg),
    persona: (text) => rewrite('persona', text),
    reply: (text, info) => mods.filter('reply', text, info),
    deniedTools: () => bridge?.deniedTools() || [],
    groupDecide: (decision, info) => mods.filter('group/decide', decision, info),
    prompt: (content, info) => mods.filter('prompt', content, info),
    items: (items, info) => mods.filter('reply/items', items, info),
    send: hubSendHook,
    model: (sel, chat) => mods.filterSync('model', sel, chat),
    poke: (ev) => mods.claim('poke', ev),
  }

  hub = createHub({
    localApi: local,
    dsh: ctx,
    getConfig,
    egressRef,
    resolveChatOfSession: (sid) => modularCoreApi?.chatKeyOfSession?.(String(sid)) || '',
    log: logger.child('chat'),
    onebot: hubOnebot,
    stickers,
    tts,
    buildTools: (where) => mods.buildTools(where),
    // 会话上下文：只放模块给的（记忆、近况……）。
    // 按聊天换人设不在这里做——那会变成「系统卡 + 追加块」两套人设；
    // 现在由 hub 的 mount() 在 agent 作用域里遮蔽 {{qq_hub_persona}}，整份提示词只有一套人设。
    contextProviders: hubContextProviders,
    onActivity: (a) => mods.emit('activity', a),
    // 群聊话题和她的记忆有多相关（插话判断用）
    // 传 chat：话题相关度只在当前聊天可见的记忆里算，别处的记忆不该让她在群里「感兴趣」
    memoryScore: (text, chat) => use('memory')?.topicScore?.(text, chat) ?? 0,
    // QQ 里的主人命令（模块加的命令优先）
    onCommand: async (msg) => {
      const cmd = parseCommand(msg.text, mods.commands())
      if (!cmd) return null
      if (cmd.ext) return String((await cmd.ext.run(cmd.arg, msg)) ?? '')
      return runCommand(cmd, msg, { getConfig, setConfig, mutes, hub, mood: use('mood'), memory: use('memory'), qzone: use('diary'), song: use('song'), listModels: models.listModels, defaultModel: () => defaultModel(ctx, { model: {} }), extraCommands: mods.commands() })
    },
    isMuted: (chatId) => mutes.muted(chatId),
    moodEffects: () => use('mood')?.effects?.() ?? null,
    availableModels: () => models.cache,
    // 模块（重）启动代际：模块热重载后工具名没变、但实例换了，hub 要据此重挂工具（issue #73）
    toolsGeneration: () => (mods ? mods.generation?.() || 0 : 0),
    hooks: sharedHooks,
  })

  const stickerStash = new Map()
  const stickerTtl = 30 * 60_000
  function loadStickerStash() {
    const stored = readJson(dataDir('sticker-stash.json'), () => ({}))
    for (const [chatId, entry] of Object.entries(stored || {})) {
      if (Array.isArray(entry?.segs) && entry.segs.length && Date.now() - Number(entry.at || 0) < stickerTtl
        && Number(entry.at) >= Number(stickerStash.get(chatId)?.at || 0)) stickerStash.set(chatId, entry)
    }
  }
  function rememberStickers(chatId, segments) {
    loadStickerStash()
    const segs = segments.slice(0, 4)
    if (!segs.length) return 0
    stickerStash.set(chatId, { at: Date.now(), segs })
    const stored = Object.fromEntries([...stickerStash].filter(([, entry]) => Date.now() - entry.at < stickerTtl))
    try { writeJson(dataDir('sticker-stash.json'), stored) } catch (error) { log.debug('表情暂存落盘失败：', error.message) }
    return segs.length
  }
  if (useModularCore) {
    const legacyStickerOf = hub.stickerOf.bind(hub)
    hub.stickerOf = (chatId, index) => {
      loadStickerStash()
      const entry = stickerStash.get(String(chatId))
      if (!entry) return legacyStickerOf(chatId, index)
      const i = Number(index) - 1
      return Date.now() - entry.at <= stickerTtl && Number.isInteger(i) && i >= 0 ? entry.segs[i] || null : null
    }
  }

  // ---------- RFC-0001 Phase 0/1：FLAG_USE_PIPELINE 熔断开关（US-003 / US-007） ----------
  // 开关关闭（默认）：dispatchEvent 直调 hub.onMessage/onPoke，与重构前完全一致，不装配管道。
  // 开关打开：onebot 实时事件流走 compose([tracing → ratelimit → acl → dedup → 边界 flush → egress → 入口合流 → 遗留终端])。
  // backfill 补收、deliver/pushToSession 等旁路入口不经管道（边界见 docs/rfc0001-mapping.md）。
  const pipelineApi = assemblePipeline({
    usePipeline, egressMode, memoryAssemblyOn,
    ctx, getConfig, setConfig, logger, log,
    hub, getMods: () => mods, use, mutes, onebot,
    listModels: models.listModels,
  })

  // ---------- M4：模块化新核心组装根（FLAG_MODULAR_CORE，默认开；显式关闭态零装配） ----------
  const modularCoreApi = useModularCore
    ? createModularCore({
        dsh: ctx,
        onebot,
        mods: {
          // 惰性代理：mods 在下方才创建；每事件现取（模块热重载即时生效，与 legacy 同语义）
          contextFor: (args) => (mods ? mods.contextFor(args) : ''),
          commands: () => (mods ? mods.commands() : []),
          use: (id) => (mods ? mods.use(id) : null),
          emit: (event, ...args) => mods?.emit(event, ...args),
        },
        getConfig,
        setConfig,
        logger,
        log,
        personaText: () => rewrite('persona', currentPersonaText(cfg.persona.current)),
        runCommand: async (cmd, msg) => {
          if (cmd.ext) return String((await cmd.ext.run(cmd.arg, msg)) ?? '')
          return runCommand(cmd, msg, { getConfig, setConfig, mutes, hub, mood: use('mood'), memory: use('memory'), qzone: use('diary'), song: use('song'), listModels: models.listModels, defaultModel: () => defaultModel(ctx, { model: {} }), extraCommands: mods ? mods.commands() : [] })
        },
        // 真实持久化（报告 §4.4/§5.6）：投递台账 + 会话映射落插件数据目录；fail-closed 由 ledger 承担
        ledgerFile: dataDir('deliveries.json'),
        sessionStoreFile: dataDir('modular-sessions.json'),
        // 真机审计补齐：群闸的心情调制/话题相关度（与 hub 同源注入）、静音、旁路指令、按聊天人设
        moodEffects: () => (use('mood')?.effects?.() ?? null),
        memoryScore: (text, chat) => { try { return use('memory')?.topicScore?.(text, chat) ?? 0 } catch { return 0 } },
        isMuted: (chatId) => mutes.muted(chatId),
        // 真机审计 1.11：面板统计与「最近发来的图/表情」登记（legacy 同一份内存状态）
        onStats: (k) => { try { hub.bumpStats?.(k) } catch {} },
        // 宿主侧变量缺失兜底：热重载后根作用域的 variable 可能已失效，按会话补注册
        promptVars: promptVarText,
        // 富媒体出站（真机审计：语音/表情/图片/引用/戳一戳）交给 legacy deliver——那条管线里
        // 有 TTS 合成、表情库取图、图片上传、引用拼装、气泡节奏，全部现成且经过线上验证；
        // 只在「这一轮回复里确实带富媒体标记」时才走它，纯文字仍走 outbox（台账/试运行/泄漏闸照旧）。
        legacyDeliver: (chatId, text, opts) => hub.deliver(chatId, text, opts),
        // 模块工具挂载（真机实测：新核心没挂，导致她连 qq_send_sticker / 记忆 / B站 / 群管都没有，
        // 只能拿 bash+curl 自己绕）。与 legacy mount() 同一份工具生成器与代际口径。
        buildTools: (where) => mods.buildTools(where),
        // 面板指定模型的在否校验（转正平账）：与 legacy hub 同一份在线清单缓存，
        // 模型从 DSH 消失时 resolveChatModel 才能「退回下一级」而不是抱着死模型名硬选。
        availableModels: () => models.cache,
        // 本地接口（语音识别等）：面板「本地」页的脚本槽，legacy transcribe 用的同一个 localApi
        localApi: local,
        // 入站聊天流水（记忆整理/蒸馏/黑话/日记的数据源）
        logChat: (chatId, who, text, uid) => { try { hub.logChat?.(String(chatId), String(who || ''), String(text || ''), uid ? String(uid) : '') } catch {} },
        // 回合说话人登记（hub.turnState；speakersOf 的数据源）
        noteSpeakers: (sessionId, senders, opts) => { try { hub.noteTurnSenders?.(String(sessionId), senders, opts) } catch {} },
        collectInboundStickers: (chatKey, segments, userId) => {
          try {
            const cfg = getConfig()
            const settings = cfg.stickers
            if (!settings?.enabled || !settings.collect) return
            if (chatKey.startsWith('group:') ? !settings.fromGroups : !settings.fromPrivate) return
            const stickers = (Array.isArray(segments) ? segments : []).filter(isStickerSegment)
            if (!stickers.length) return
            const mode = settings.collectMode || 'auto'
            if (mode === 'auto') {
              for (const seg of stickers) Promise.resolve(hub.collectInboundSticker?.(seg, chatKey)).catch(() => {})
              return
            }
            const count = rememberStickers(chatKey, stickers)
            return mode === 'owner' && String(userId) !== String(cfg.ownerQQ || '') ? 0 : count
          } catch { /* 收表情是旁路 */ }
        },

        toolsGeneration: () => mods.generation?.() || 0,
        moduleHooks: sharedHooks,
        sharedOutbox,
        rememberPoker: (chatId, uid) => hub.rememberPoker?.(chatId, uid),
        claimPoke: (chatId) => hub.claimPoke?.(chatId) ?? true,
        rememberSpeaker: (chatId, uid) => hub.rememberSpeaker?.(chatId, uid),
        isSentMessage: (messageId) => hub.wasSent?.(messageId) ?? false,
        markTurnAt: (chatId) => hub.markTurnAt?.(chatId),
        noteMedia: (chatKey, segments, userId) => { try { hub.noteRecentMedia?.(chatKey, segments, userId) } catch {} },
        interceptInteraction: (m) => { try { return !!hub.interceptInteraction?.(m) } catch { return false } },
        personaTextFor: (chat) => {
          try {
            const c = getConfig()
            const want = personaIdFor(chat, c)
            if (!want || want === String(c.persona?.current || '')) return null // 跟随全局
            const p = readPersona(want)
            return p?.body ? rewrite('persona', p.body) : null
          } catch { return null }
        },
      })
    : null
  // 主动任务只生成回合复用当前 QQ 会话；投递仍由调用方走统一 Outbox。
  if (useModularCore && modularCoreApi) {
    hub.runPromptTurn = (chatKey, text) => modularCoreApi.runPromptTurn(chatKey, text)
    hub.markTurnAt = (chatKey, now) => modularCoreApi.markTurnAt(chatKey, now)
  }
  // 开旗态：让 legacy hub 的会话查询/重置也能看到新核心的会话。
  // token-guardian、审批桥、用量转发都走这两个函数，之前它们查 legacy sessions.json → 新核心会话永远查不到
  // （真机：token-guardian 报「无可重置的会话」、审批卡发不到 QQ）。包一层即一次性修好所有调用方。
  if (useModularCore && modularCoreApi) {
    const legacyChatOfSession = hub.chatOfSession?.bind(hub)
    const legacyResetChat = hub.resetChat?.bind(hub)
    const legacySessions = hub.sessions?.bind(hub)
    const legacyResetSessions = hub.resetSessions?.bind(hub)
    const legacyOnSessionEvent = hub.onSessionEvent?.bind(hub)
    const legacySyncAllModels = hub.syncAllModels.bind(hub)
    hub.syncAllModels = async () => {
      const results = await Promise.all([legacySyncAllModels(), modularCoreApi.syncAllModels()])
      return {
        applied: results.reduce((n, r) => n + r.applied, 0),
        skipped: results.reduce((n, r) => n + r.skipped, 0),
        failed: results.reduce((n, r) => n + r.failed, 0),
        dropped: results.reduce((n, r) => n + (r.dropped || 0), 0),
        detail: results.flatMap((r) => r.detail || []),
      }
    }
    hub.sessions = () => ({ ...(legacySessions?.() || {}), ...modularCoreApi.sessions() })
    hub.resetSessions = () => {
      const ids = Object.keys(modularCoreApi.registry.snapshot())
      for (const chatId of ids) hub.resetChat(chatId)
      return ids.length + Number(legacyResetSessions?.() || 0)
    }
    hub.onSessionEvent = (session, event) => {
      if (event?.type === 'user/message' && event?.data?.source?.kind === 'user') {
        const sid = String(session?.id || '')
        if (modularCoreApi.chatKeyOfSession?.(sid)) hub.noteTurnSenders?.(sid, hub.speakersOf?.(sid) || [], { directOwner: true })
      }
      return legacyOnSessionEvent?.(session, event)
    }
    // 优先问**新核心**：开旗态下它才是真正在跑的会话；legacy 表里那份多为历史遗留
    // （真机实测：先问 legacy 会「归档了 legacy 会话、却把新核心会话留着不动」，
    //  token-guardian 以为压缩成功，实际上下文一点没变小）。
    hub.chatOfSession = (sid) => {
      try { const k = modularCoreApi.chatKeyOfSession?.(String(sid)); if (k) return k } catch {}
      try { return legacyChatOfSession?.(sid) || '' } catch { return '' }
    }
    hub.resetChat = (chatId) => {
      try { if (modularCoreApi.resetChat?.(String(chatId))) return true } catch {}
      try { return Boolean(legacyResetChat?.(chatId)) } catch { return false }
    }
    log.debug('已把 hub.chatOfSession / hub.resetChat 接到新核心会话表')
  }
  if (useModularCore) log.info('M4 模块化新核心（FLAG_MODULAR_CORE）：开 — 实时事件/补收走 Registry→Turn→Assembly→Outbox；物理发送唯一出口 = outbox')

  // ---------- 面板接口的小工具 + 模块前缀路由 ----------
  const http = createHttpKit({ ctx, prefix: PREFIX, getConfig, isAuthorized: (req) => bridge?.authorized(req) === true, log: logger.child('panel') })
  const { send, readBody, readRaw, query, answer, route, guard } = http
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX, // DSH 按「路径 = 前缀 或 以 前缀/ 开头」匹配，前缀本身不带结尾的 /
    handler: (req, res) => answer(res, () => {
      // 模块前缀路由与精确路由同一道防护（Host/CSRF、副作用方法约束；/open/* 保留联动密钥鉴权）。
      const g = guard.check(req)
      if (!g.ok) return send(res, g.code, { ok: false, message: g.message })
      let path = ''
      let qs = {}
      try {
        const u = new URL(req.url, 'http://x')
        path = u.pathname
        qs = Object.fromEntries(u.searchParams)
      } catch (error) {}
      // 模块的 handler 拿到的 req 是原始 IncomingMessage，**没有 query 属性**。
      // 以前模块里写 `req?.query?.xxx` 全是 undefined（token-guardian 的「现在压一次」、
      // memory-privacy 的 id/all、telemetry 的 days 都中招，2026-11-04 排查）。
      // 这里统一挂上去，内置模块和用户自写的扩展都能直接用 req.query。
      try { req.query = qs } catch (error) {}
      return mods.handle(path, req, res)
    }),
  }), 'qq-hub: 模块接口')

  // ---------- 面板聚合视图（overview/脱敏/连接诊断，见 host/panel/overview.js） ----------
  const overviewApi = createPanelOverview({
    ctx, getConfig,
    snowluma, onebot, endpoint,
    gatewayState,
    hub, getBridge: () => bridge, getMods: () => mods,
    use, stickers,
    VERSION, API_VERSION,
  })

  // ---------- 模块 ----------
  const core = {
    hub, onebot, snowluma, local, groupRoles, mutes, logger, bridge: null,
    root: ROOT,
    ask: (opts) => askModel(ctx, { cfg: getConfig(), ...opts }),
    listModels: models.listModels,
    defaultModel: () => defaultModel(ctx, { model: {} }),
    http: { body: readBody, raw: readRaw, query, send },
    personas: { list: listPersonas, read: readPersona, current: () => currentPersonaText(cfg.persona.current) },
    getConfig, setConfig,
  }
  // 真机审计 §2：开旗态把模块侧文本发送并入新核心 outbox 唯一出口（台账/dryRun/泄露闸从此对模块生效）
  if (modularCoreApi) core.hub = createModuleSendBridge({ hub, outbox: modularCoreApi.outbox, log: logger.child('模块出站'), legacyUnified: true })
  mods = createModules({ ctx, core, getConfig, setConfig, logger, version: VERSION, builtins: BUILTINS })
  bridge = createBridge({ ctx, getConfig, setConfig, hub, mods, log: logger.child('bridge'), version: VERSION, apiVersion: API_VERSION, overview: () => overviewApi.overview() })
  core.bridge = bridge
  core.modules = mods
  // 危险命令确认（可选保护）：DSH 在真正执行终端工具前会走 tools/pre-execute；
  // 这里只拦 bash / pwsh 的危险命令，其它工具和普通命令原样放行。
  dangerGuard = createDangerGuard({
    getConfig,
    log: logger.child('危险命令'),
    deliver: (chatId, text) => hub.sendText(chatId, text),
    chatOfSession: (sessionId) => { try { return hub.chatOfSession?.(sessionId) || '' } catch (error) { return '' } },
    ownerQQ: () => cfg.ownerQQ,
  })
  core.dangerGuard = dangerGuard
  ctx.effect(() => {
    let off = null
    try { off = ctx.on('tools/pre-execute', (exec, next) => dangerGuard.preExecute(exec, next)) } catch (error) { log.debug('挂危险命令确认失败：', error.message) }
    return () => { try { if (typeof off === 'function') off() } catch (error) {} }
  }, 'qq-hub: 危险命令确认')

  // ---------- 宿主旁路 seam（审批流/交互提问/会话监听/看门狗，见 host/effects.js） ----------
  const effects = createHostEffects({
    ctx, logger, log, getConfig, hub, mods, use, snowluma, onebot, gatewayState,
    // 开旗后会话由新核心创建，legacy sessions.json 里没有 → 审批/提问桥接要能反查到 chatKey
    chatKeyOfSession: (sid) => (modularCoreApi?.chatKeyOfSession?.(String(sid)) || ''),
  })
  effects.installApprovalFlow()
  effects.setupUserQuestions()

  const booted = mods.boot()
  booted.then(() => bridge.refresh())

  effects.installSessionWatcher()
  effects.installWatchdog()

  ctx.effect(() => () => {
    // US-008：管道里的合流中间件先卸（清窗口定时器 + 中止挂起 ctx），flag-off 时为 null
    try { pipelineApi.aggregator?.dispose?.() } catch (error) { log.warn('入口合流卸载出错：', error.message) }
    hub.disposeRecentMedia()
    mods.dispose()
    onebot.stop()
    snowluma.dispose()
  }, 'qq-hub: 收尾')

  // 「打开文件夹」面板按钮共用（本地脚本目录 / 模块目录）
  const openFolder = (dir) => {
    mkdirSync(dir, { recursive: true })
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true, message: '打开了' }
  }

  // ---------- 面板路由（按域注册，见 host/panel/routes-*.js；注册顺序与拆分前一致） ----------
  registerConfigRoutes({
    route, readBody,
    dsh: ctx,
    getConfig, setConfig,
    snowluma, onebot, gatewayState, hub, getMods: () => mods,
    overview: overviewApi.overview, log, safe: effects.safe, watchdog: effects.watchdog,
  })
  registerPurposeRoutes({
    route, readBody,
    getConfig, setConfig,
    use, log,
    purposeOverview: overviewApi.purposeOverview, redactTokens: overviewApi.redactTokens,
  })
  registerGatewayRoutes({
    route, readBody, query,
    getConfig, setConfig,
    snowluma, onebot, gatewayState, hub,
    connectionProblem: overviewApi.connectionProblem, overview: overviewApi.overview, resetConsent: overviewApi.resetConsent,
    getMods: () => mods, log,
    pkg: PKG, version: VERSION, root: ROOT,
  })
  // /persona/use 的既有筛选匹配新 current；仅向该路由提供有效人设真正改变的会话视图。
  let personaSwitchSessions = null
  const personaPanelHub = useModularCore ? Object.create(hub) : hub
  if (useModularCore) {
    personaPanelHub.sessions = () => {
      if (personaSwitchSessions === null) return hub.sessions()
      const sessions = personaSwitchSessions
      personaSwitchSessions = null
      return sessions
    }
  }
  const setPersonaPanelConfig = useModularCore ? (next) => {
    const before = hub.sessions()
    const current = setConfig(next)
    personaSwitchSessions = Object.fromEntries(Object.entries(before).filter(([chatId, entry]) => {
      const chat = chatId.startsWith('group:') ? { kind: 'group', groupId: chatId.slice(6) }
        : chatId.startsWith('private:') ? { kind: 'private', userId: chatId.slice(8) } : { kind: 'system' }
      return entry?.personaId && entry.personaId !== personaIdFor(chat, current)
    }).map(([chatId, entry]) => [chatId, { ...entry, personaId: current.persona.current }]))
    return current
  } : setConfig
  registerPersonaRoutes({
    route, readBody, query,
    ctx, getConfig, setConfig: setPersonaPanelConfig,
    hub: personaPanelHub, log,
  })
  registerModulesRoutes({
    route, readBody, query, send,
    getConfig,
    hub, mods, openFolder,
  })
  registerMiscRoutes({
    route, readBody, query, send,
    ctx, getConfig,
    logger, local, onebot, hub, bridge,
    models, openFolder,
    avatarPath: overviewApi.avatarPath, avatarInfo: overviewApi.avatarInfo,
    root: ROOT, log,
  })

  log.info(`QQ Hub v${VERSION} 已加载｜总开关 ${cfg.enabled ? '开' : '关'}｜试运行 ${cfg.dryRun ? '开' : '关'}｜工作区 ${workspaceDirOf(cfg)}`)

  return {
    hub, onebot, snowluma, getConfig, setConfig, logger, modules: mods, bridge, ready: booted,
    get stickers() { return use('stickers') },
    get qzone() { return use('diary') },
    get mood() { return use('mood') },
    get memory() { return use('memory') },
  }
}
