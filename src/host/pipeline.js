// QQ Hub · RFC-0001 洋葱管道装配（host.js 分层拆出）
//
// FLAG_USE_PIPELINE 开启态的整链装配：tracing → ratelimit → acl → dedup → 边界 flush →
// egress → 命令路由 →（入口合流）→（persona/memory 装配）→ 遗留 hub 终端。
// 关闭态（默认）本工厂不装配任何东西，dispatchLegacyPipeline 保持未被调用。
// 中间件语义与灰度位见 docs/rfc0001-mapping.md。

import { readFileSync, existsSync, statSync } from 'node:fs'
import { compose } from '../kernel/compose.js'
import { createContext } from '../kernel/context.js'
import { createLegacyHubFallback, legacyEventToEnvelope, LEGACY_DRIVER_ID } from '../kernel/legacy-fallback.js'
import { createTracingMiddleware } from '../kernel/mw-tracing.js'
import { createDispatcher } from '../kernel/dispatcher.js'
import { createEgressMiddleware } from '../kernel/mw-egress.js'
import { createEgressFlushMiddleware, createEgressSender } from '../kernel/mw-egress-cutover.js'
import { createAggregatorMiddleware, isIngressAggregatorEnabled } from '../kernel/mw-aggregator.js'
import { createRatelimitMiddleware, ratelimitOptionsFromEnv } from '../kernel/mw-ratelimit.js'
import { createAclMiddleware } from '../kernel/mw-acl.js'
import { createDedupMiddleware } from '../kernel/mw-dedup.js'
import { createPersonaInjector, chatFromInbound } from '../kernel/mw-persona.js'
import { createMemoryRetriever } from '../kernel/mw-memory.js'
import { createCommandRouterMiddleware } from '../kernel/mw-command-router.js'
import { isOwner } from '../chat/access.js'
import { parseCommand, runCommand } from '../chat/commands.js'
import { defaultModel } from '../core/llm.js'
import { personaIdFor, readPersona, currentPersonaText } from '../persona/personas.js'

export function assemblePipeline({
  usePipeline, egressMode, memoryAssemblyOn,
  ctx, getConfig, setConfig, logger, log,
  hub, getMods, use, mutes, onebot,
  listModels,
}) {
  /** RFC-0001 熔断开关开启态的洋葱管道；关闭态（默认）恒为 null，装配见下方 if 块。 */
  let legacyPipeline = null
  // US-008：入口合流中间件实例（dispose 由 ctx.effect 收尾统一回收定时器/挂起 ctx）
  let pipelineAggregator = null

  /** 开启态：旧事件构造 RFC 信封 → kernel createContext → 整链 await 走管道（终端仍是旧 hub 入口）。 */
  async function dispatchLegacyPipeline(ev) {
    const kctx = createContext(legacyEventToEnvelope(ev), LEGACY_DRIVER_ID)
    // gemini38 缺陷2（父信号泄漏预炸点）接线：createContext 支持第 4 参 {signal}
    // （review A2 P1），转发闭包只有 abort/dispose 两条摘除出口；本调用点是全仓唯一
    // 生产实调用，若将来透传长命父信号（HTTP 断开/会话超时）而这里不收尾，监听闭包
    // 会逐事件线性累积。故在管道**真实 settle 之后**统一 dispose——必须 await 再
    // finally（同步 finally 会在派发前就摘掉监听，父取消在飞窗口直接失效）。
    // 现产未传父信号 → dispose 是空操作，默认/flag-off 路径行为逐字不变。
    try {
      return await legacyPipeline(kctx)
    } finally {
      kctx.dispose?.()
    }
  }

  if (usePipeline) {
    // US-007：Dispatcher 的物理出口。sender 用的是**没被包装的**原 onebot 客户端，
    // 所以「旧通道直发」和「新链路下发」不会互相套娃；upload_*_file 保留 hub 的长超时
    // 与「网关看不到本机路径 → 改走 base64」回退（大小口径同 hub 的 30MB 上限）。
    const egressSender = createEgressSender({
      call: (action, params, opts) => onebot.call(action, params, opts),
      uploadFile: (file) => {
        const maxBytes = 30 * 1024 * 1024
        if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size > maxBytes) return ''
        return 'base64://' + readFileSync(file).toString('base64')
      },
      log: logger.child('egress'),
    })
    // shaping 参数就是 chat/reply.js bubbleDelay 的口径（clamp 后 × 0.8~1.3 抖动）；
    // 当前投递的 payload 一律带 delayMs=0（US-007 拍板），所以这里只做兜底：
    // 谁以后给 payload 显式留空 delayMs，就自动按打字估时整形。
    // US-008 灰度位：入口合流是否装进管道（默认 false = 旧 pending 路径）
    const useIngressAggregator = isIngressAggregatorEnabled(process.env)
    if (useIngressAggregator) {
      pipelineAggregator = createAggregatorMiddleware({
        getConfig: () => getConfig(),
        log: logger.child('aggregator'),
      })
    }
    const dispatcher = createDispatcher({
      mode: egressMode,
      sender: egressSender,
      log: logger.child('dispatcher'),
      shaping: { baseMs: 350, perCharMs: 110, minGapMs: 700, maxGapMs: 4500 },
    })
    // US-010：上下文装配两件（NEW_MEMORY_PIPELINE=true 才进管道；关时数组与 US-009 等价）。
    // - persona：hub 内部直读 personas.js（红线不动），本件为**预取 + 打点**，state 快照供
    //   观测与 Phase 4 消费；人设源每事件实时读 cfg + 人格卡文件（面板改卡下一事件即生效）。
    // - memory：检索 features/memory.js 现行 contextFor/listFor（每事件实时读=热重载），
    //   结果写 ctx.state；contextProviders 的 takeover 层据此供给。
    // 拍板顺序：persona/memory 在 aggregator **之后**（lead 放行后为合并回合装配一次，
    // 同窗 followers 在聚合层就 abort，根本到不了检索），legacy 终端之前。
    const personaAssembly = createPersonaInjector({
      getPersona: (chat) => {
        const c = getConfig()
        const want = personaIdFor(chat, c)
        const globalId = (c.persona || {}).current || ''
        const p = want ? readPersona(want) : null
        return {
          id: want || globalId,
          name: p && p.name ? p.name : '',
          body: p && p.body ? p.body : currentPersonaText(want || globalId),
          perChat: Boolean(want && want !== globalId),
        }
      },
      log: logger.child('persona-mw'),
    })
    const memoryAssembly = createMemoryRetriever({
      // 注入面每事件现取：模块热重载（generation 变了换了实例）自动跟上
      memory: (() => {
        const m = () => use('memory')
        return {
          contextFor: (chat, sessionId) => m()?.contextFor?.(chat, sessionId) ?? '',
          listFor: (scopes, opts) => m()?.listFor?.(scopes, opts) ?? [],
        }
      })(),
      log: logger.child('memory-mw'),
    })
    // US-011：命令路由（无独立灰度位——拍板数组直接进管道；flag-off 整段不装配，零改动红线保住）。
    // 判定口径逐条对齐 hub.onMessage 的 legacy 命令闸门（hub.js:1350-1376）：
    //   - approvals.handleReply 与 slash 命令在正则上互斥（其 token 表不含斜杠），无需守卫；
    //   - hub.questions.has 命中 → 透传（legacy 顺序：交互提问先于命令闸门消费该文本）；
    //   - ext 模块命令 → 透传（ext.run 吃 hub 全套 msg 形状——images/forwards/replyId/raw——
    //     信封视图补齐不可信，矩阵诚实留给 legacy；questions.test 亦钉住该文本形态）；
    //   - 非主人 / 非斜杠开头 → 透传（isOwner 复用 chat/access.js，同 hub.js:1366 一份权威）；
    //   - 混有非 text 段（图/表情/录音/转发）→ 透传（legacy recentMedia.remember 先于命令闸门
    //     记媒体，接管会跳过记录——少拦一条命令换语义完整）。
    // handler 复用 legacy onCommand 同款 runCommand 与同一 deps 闭包（模块实例
    // 每事件现取，热重载跟上）；回复经 hub.sendSegments 在 ALS 里落出口切换包装器
    // → ctx.reply.enqueue，总开关 force 豁免 / 试运行 / 身份闸三道安全闸一字不动。
    const runOwnerCommand = async (cmd, msg) => {
      const reply = await runCommand(cmd, msg, { getConfig, setConfig, mutes, hub, mood: use('mood'), memory: use('memory'), qzone: use('diary'), song: use('song'), listModels, defaultModel: () => defaultModel(ctx, { model: {} }), extraCommands: getMods().commands() })
      if (!reply) return // 空回复：mw 以零入队增量透传下游，复刻 legacy「命令没答话就继续当聊天」
      log.info(`主人命令 ${String(msg.text).trim().slice(0, 30)} → ${String(reply).split('\n')[0]}`)
      await hub.sendSegments(msg.chatId, [{ type: 'text', data: { text: String(reply) } }], String(reply).slice(0, 60), { force: true })
    }
    const pipelineCommandRouter = createCommandRouterMiddleware({
      parse: (kctx) => {
        const inbound = kctx?.inbound
        if (!inbound || inbound.type !== 'message') return null
        const text = String(inbound.rawText || '')
        if (!/^\s*[/／]/.test(text)) return null
        const chat = chatFromInbound(inbound)
        if (!chat) return null
        const c = getConfig()
        if (!isOwner(c, chat.userId || '')) return null
        if (Array.isArray(inbound.segments) && inbound.segments.some((seg) => seg.type !== 'text')) return null
        if (hub.questions?.has?.(chat.chatId)) return null
        const cmd = parseCommand(text, getMods().commands())
        if (!cmd || cmd.ext) return null
        return { cmd, msg: { ...chat, nickname: c.ownerName || '主人', text } }
      },
      // 覆盖矩阵「router 直答」列：runCommand 的 deps 注入面全部 host 可达（含 hub 公开方法
      // stats/resetChat/joinTopic/leaveTopic），16 个内置命令逐一登记；未登记的自动透传。
      handlers: {
        help: runOwnerCommand, silent: runOwnerCommand, active: runOwnerCommand, quiet: runOwnerCommand,
        chatty: runOwnerCommand, normal: runOwnerCommand, model: runOwnerCommand, sing: runOwnerCommand,
        status: runOwnerCommand, mood: runOwnerCommand, diary: runOwnerCommand, remember: runOwnerCommand,
        reset: runOwnerCommand, new: runOwnerCommand, on: runOwnerCommand, off: runOwnerCommand,
      },
      log: logger.child('router'),
    })
    legacyPipeline = compose([
      // RFC Middleware 1（US-004）：最外层 tracing，回溯阶段一行 debug 打点 total/mw0/mw1/err
      createTracingMiddleware({ log: logger.child('trace') }),
      // US-009：入口防御链（RFC §2.1 Tracing→RateLimiter→ACL→Dedup→终端）。
      // 刻意放在出口 flush/egress 之前：被守卫 abort 的事件按 compose §2.2（US-008a）
      // 其后各级两级不进——出口链、聚合窗、旧核心都不为限流/无权/重传流量做记账；
      // 外层 tracing 的 bubble 照常收尾打点（aborted 标记，不计错误）。
      // 旋钮（US-012 配置化尾巴）：QQHUB_RL_CAPACITY / QQHUB_RL_REFILL_PER_SEC 装配期一次性
      // 读 env，非法值回构造缺省（30 突发 + 5/s 持续 / LRU 2048）——口径同四个管道开关，
      // 改 env 需重启；ACL 复用 chat/access.js 判定（fail-closed），
      // ratelimit/dedup 判定异常 fail-open。
      createRatelimitMiddleware({ ...ratelimitOptionsFromEnv(process.env), log: logger.child('ratelimit') }),
      createAclMiddleware({ getConfig: () => getConfig(), log: logger.child('acl') }),
      createDedupMiddleware({ log: logger.child('dedup') }),
      // US-007：边界 flush——必须在 egress 外层，回溯顺序才是「清洗 → 下发」
      createEgressFlushMiddleware({ dispatcher, log: logger.child('egress-shadow') }),
      // US-006：防思考泄漏截尾 + stripReasoning + 4000 字语义分条
      createEgressMiddleware({ log: logger.child('egress') }),
      // US-011：命令路由——必须在边界 flush/egress **内侧**（更深层）：命中入队的回复
      // 交给外层 bubble 清洗+drain 下发，与 legacy 流量同一出口路径；又必须在
      // aggregator/persona/memory/legacy **外侧**：命令不进聚合窗、不触发记忆检索，即时应答。
      // 未命中/未适配/抛错 → next() 透传（legacy 命令闸门复检兜底，双权威顺序不变）。
      pipelineCommandRouter,
      // US-008：入口合流防抖——必须紧贴遗留终端（在它之前 = 更外层），
      // 这样 followers 被 abort 时旧核心还没被派发，两级都不进，天然不会双发。
      // merge.* 参数与 hub 内部 pending 共用同一份配置，语义对齐 hub.enqueue。
      // 灰度：legacy 核心仍自持逐事件 Ingress，吞掉 followers 会让它只看得到 lead
      // 那一条报文（实测丢消息），所以本层另吃 FLAG_INGRESS_AGGREGATOR，默认不装；
      // Ingress 收编（US-009/Phase 3）后再并进 FLAG_USE_PIPELINE。
      ...(useIngressAggregator ? [pipelineAggregator] : []),
      // US-010：装配层在聚合之后、终端之前——lead 放行后为合并回合装配一次人设+记忆
      ...(memoryAssemblyOn ? [personaAssembly, memoryAssembly] : []),
      createLegacyHubFallback(hub),
    ])
    log.info(`RFC-0001 管道开关（FLAG_USE_PIPELINE）：开 — 事件走洋葱管道，遗留 hub 作终端；入口防御链=开（ratelimit/acl/dedup）；出口=${egressMode}（治理面实况=队列支路：router 命令直答与 hub 闸门透传回复；主聊天气泡由 turn/end 异步投递、落在终端 await 之后，命中包装器直发分支，不经队列/清洗/pacing/shadow 比对——见补评 F1）；入口合流=${useIngressAggregator ? '挂载（暂停透传，见 review A1/A2）' : '关（FLAG_INGRESS_AGGREGATOR）'}；上下文装配=${memoryAssemblyOn ? '开（persona/memory 接管，NEW_MEMORY_PIPELINE）' : '关（legacy provider 链）'}；命令路由=开（内置命令接管，ext/边界形态透传 legacy）}`)
  }

  return {
    dispatchLegacyPipeline,
    /** 收尾用：flag-off 时为 null。 */
    get aggregator () { return pipelineAggregator },
  }
}
