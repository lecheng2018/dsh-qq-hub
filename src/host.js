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
import { dataDir } from './core/store.js'
import { createLogger } from './core/logger.js'
import { registerSecret } from './core/redact.js'
import { createSnowLumaManager } from './snowluma/manager.js'
import { createHub, workspaceDirOf } from './chat/hub.js'
import { createLocal } from './local/local.js'
import { createGroupRoles } from './chat/group-roles.js'
import { defaultModel, askModel } from './core/llm.js'
import { parseCommand, runCommand, createMutes } from './chat/commands.js'
import { listPersonas, readPersona, currentPersonaText, rulesText, seedPersonas } from './persona/personas.js'
import { createModules, API_VERSION } from './core/modules.js'
import { createBridge } from './core/bridge.js'
import { createDangerGuard } from './security/danger.js'
import { BUILTINS } from './modules/index.js'
// RFC-0001 Phase 0（US-003）：遗留核心终端化 + FLAG_USE_PIPELINE 熔断开关
import { isPipelineEnabled, isModularCoreEnabled, unwrapPipelineError } from './kernel/legacy-fallback.js'
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
  variable('qq_hub_persona', () => rewrite('persona', currentPersonaText(cfg.persona.current)))
  variable('qq_hub_rules_private', () => {
    const base = rewrite('rules', rulesText('private', cfg, rulesOpts('private')), 'private')
    // 危险命令确认开着时补一句：被拦下要如实告诉主人，别绕着写
    return base + (cfg.security && cfg.security.dangerConfirm
      ? '\n【危险命令】终端命令如果被安全策略拦下（删根目录/格式化/关机/下载后直接执行等），把命令原文和原因如实告诉主人，等主人回复「确认」后再重试；不要换一种写法绕过。'
      : '')
  })
  variable('qq_hub_rules_social', () => rewrite('rules', rulesText('social', cfg, rulesOpts('social')), 'social'))

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
   *  FLAG_MODULAR_CORE 开（默认关）→ 实时事件走新核心（Registry→Turn→Assembly→Outbox）；
   *  否则 FLAG_USE_PIPELINE 开 → 洋葱管道；都关 → 直调遗留 hub（默认路径逐字不变）。 */
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

  hub = createHub({
    localApi: local,
    dsh: ctx,
    getConfig,
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
    hooks: {
      message: (msg) => mods.claim('message', msg),
      // 专用卡（按聊天换人设）也过一次模块改写，和全局人设走同一条路
      persona: (text) => rewrite('persona', text),
      reply: (text, info) => mods.filter('reply', text, info),
      deniedTools: () => bridge?.deniedTools() || [],
      groupDecide: (decision, info) => mods.filter('group/decide', decision, info),
      prompt: (content, info) => mods.filter('prompt', content, info),
      items: (items, info) => mods.filter('reply/items', items, info),
      // US-007：开启态换成出口切换变体（内部照样先跑 mods.filter('send', …)，模块语义一字不动）
      send: hubSendHook,
      model: (sel, chat) => mods.filterSync('model', sel, chat),
      poke: (ev) => mods.claim('poke', ev),
      // security-lock 模块已移除：不再提供锁状态，approvals 的锁分支自然不会触发
    },
  })

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

  // ---------- M4：模块化新核心组装根（FLAG_MODULAR_CORE，默认关；关闭态零装配） ----------
  const useModularCore = isModularCoreEnabled(process.env)
  const modularCoreApi = useModularCore
    ? createModularCore({
        dsh: ctx,
        onebot,
        mods: {
          // 惰性代理：mods 在下方才创建；每事件现取（模块热重载即时生效，与 legacy 同语义）
          contextFor: (args) => (mods ? mods.contextFor(args) : ''),
          commands: () => (mods ? mods.commands() : []),
          use: (id) => (mods ? mods.use(id) : null),
        },
        getConfig,
        setConfig,
        logger,
        log,
        personaText: () => rewrite('persona', currentPersonaText(cfg.persona.current)),
        runCommand: async (cmd, msg) => runCommand(cmd, msg, { getConfig, setConfig, mutes, hub, mood: use('mood'), memory: use('memory'), qzone: use('diary'), song: use('song'), listModels: models.listModels, defaultModel: () => defaultModel(ctx, { model: {} }), extraCommands: mods ? mods.commands() : [] }),
        // 真实持久化（报告 §4.4/§5.6）：投递台账 + 会话映射落插件数据目录；fail-closed 由 ledger 承担
        ledgerFile: dataDir('deliveries.json'),
        sessionStoreFile: dataDir('modular-sessions.json'),
      })
    : null
  if (useModularCore) log.info('M4 模块化新核心（FLAG_MODULAR_CORE）：开 — 实时事件/补收走 Registry→Turn→Assembly→Outbox；物理发送唯一出口 = outbox')

  // ---------- 面板接口的小工具 + 模块前缀路由 ----------
  const http = createHttpKit({ ctx, prefix: PREFIX, getConfig, log: logger.child('panel') })
  const { send, readBody, readRaw, query, answer, route, guard } = http
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX, // DSH 按「路径 = 前缀 或 以 前缀/ 开头」匹配，前缀本身不带结尾的 /
    handler: (req, res) => answer(res, () => {
      // M1-A / P1 §4.9：模块前缀路由与精确路由同一道防护（Host 白名单 + 带 Origin 不分方法同源校验
      // + 副作用路径 GET 405；模块路径不在副作用表内，靠 Origin 收紧这层挡跨站触发）
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
  const effects = createHostEffects({ ctx, logger, log, getConfig, hub, mods, use, snowluma, onebot, gatewayState })
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
  registerPersonaRoutes({
    route, readBody, query,
    ctx, getConfig, setConfig,
    hub, log,
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
