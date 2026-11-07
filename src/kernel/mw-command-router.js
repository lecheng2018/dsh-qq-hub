// 命令路由终端中间件（RFC-0001 §2.1 Terminal Handler / Command Router，§4 Phase 3 / US-011）。
//
// 职责：把「命中主人命令」的事件在管道中段短路——解析走注入面 parse，执行走
// handlers 表里的既有处理函数，回复一律进 ctx.reply 缓冲池（不直接发送），
// 命中后**不调 next()**（终端语义）；未命中/未适配/执行失败 → await next()
// 透传给下游（persona/memory → aggregator → legacyFallback），legacy 命令闸门
// 仍是第二权威。
//
// 契约（与 host 装配层之间，测试用桩件同样走这两个口子）：
//   - parse(ctx) → null（不归本层管）| { cmd, msg }
//       cmd = src/chat/commands.js parseCommand 的解析产物 { name, arg, ext? }（结构稳定）；
//       msg = 处理函数消费的入站视图（chatId/kind/userId/groupId/text 等）。
//     是否命令、是否主人、是否要留给 legacy 的**全部判定口径都在 parse 注入面**
//     （host 里逐条对齐 hub.js:1366 与 1355 的前置顺序，理由见 host 装配段注释）；
//     本中间件不复制第二套命令判定权威。
//   - handlers[cmd.name] = async (cmd, msg, ctx) => void
//     回复通过 ctx.reply.enqueue 产生（host 实现经 hub.sendSegments 在
//     runWithContext(ctx) 内落到出口切换包装器 enqueue，三道安全闸语义保留）；
//     本层以「入队增量」为接管成功判据——handler 正常返回但没产生任何回复，
//     复刻 legacy「onCommand 空回复后该条继续当普通聊天」的行为（hub.js:1368）。
//
// 兜底拍板（controller）：
//   1. parse 抛错 → fail-open 透传。判定异常不能吃掉聊天主链；legacy 命令闸门
//      会对同一条事件复检，无安全缺口（对齐 ratelimit/dedup 的资源型 fail-open，
//      区别于 acl 的权限型 fail-closed——命令路由只是执行面提前，不是权限面）。
//   2. handler 抛错 → 捕获、计数、回滚本次入队增量、透传 legacy 复检执行。
//      回滚是为了避免「半途入队 + legacy 再执行」双发；legacy 复检有再触发一次
//      副作用的理论风险（如 /remember 双写），但这是命令执行兜底的既定代价，
//      远好于让整条管道炸掉（compose 会把异常包成 PipelineError 打断全链）。
//   3. 未适配命令（handlers 无对应键，含 ext 模块命令、矩阵里透传的类别）→
//      自动透传，router 不假接管。覆盖矩阵如实写在 progress.txt。
//
// 与 abort unwind（US-008a）的联动：终端短路 = 正常 return 而非 ctx.abort，
// 其外层中间件（egress 清洗 / 边界 flush / tracing 打点）的 bubble 照常收尾；
// 入队的命令回复由外层边界 flush drain 下发，与 legacy 流量同一出口路径。
//
// G4 打点口径同 mw-persona/mw-acl：注入 reportStage 走 clock 自报 'router'
// （parse 判定段）与 'router-handler'（执行段，仅命中时）；缺省 traceStage，
// 未装 tracing 自动退化直执行。

import { traceStage } from './mw-tracing.js'
import { runWithContext } from './ctx-store.js'

/** ctx.state 上本轮命令路由结果的键（symbol 隔离；观测/回归用）。 */
export const COMMAND_ROUTER_KEY = Symbol.for('dsh-qq-hub.kernel.command-router')

/**
 * 命令路由中间件工厂。
 *
 * @param {object} [options]
 * @param {(ctx: any) => (null | { cmd: { name: string, arg: string, ext?: any }, msg: any })} [options.parse]
 *   解析/鉴权注入面（host 接线复用 src/chat/commands.js parseCommand + access.js isOwner，
 *   判定顺序对齐 hub.js:1355/1366）；缺省未接 → 一切透传。
 * @param {Record<string, (cmd: any, msg: any, ctx: any) => Promise<any>>} [options.handlers]
 *   命令名 → 既有处理函数。只有**可外部调用**的命令才登记在此（覆盖矩阵的代码形态）；
 *   未登记的命令自动透传 legacy。
 * @param {{ debug?: Function, warn?: Function, info?: Function }} [options.log]
 * @param {(name: string, ms: number) => any} [options.reportStage] G4 分段自报覆盖位
 * @param {() => number} [options.clock] 毫秒时钟（缺省 Date.now；测试注入假时钟）
 * @returns {((ctx: any, next: () => Promise<void>) => Promise<void>) & { stats(): object }}
 */
export function createCommandRouterMiddleware(options = {}) {
  const { parse, handlers = {}, log, reportStage, clock = () => Date.now() } = options

  const counters = {
    passthrough: 0,     // 未命中命令（含 parse 判 null / 不归本层管）
    matched: 0,         // 命中命令（进入执行面）
    intercepted: 0,     // 接管成功（产生回复入队并短路）
    fellThrough: 0,     // handler 正常返回但零回复 → 复刻 legacy 继续当聊天
    noHandler: 0,       // 命中但未适配 → 透传 legacy（矩阵诚实位）
    parseErrors: 0,     // parse 抛错（fail-open 透传）
    handlerErrors: 0,   // handler 抛错（回滚 + 透传 legacy 兜底）
  }

  const dbg = (msg) => { try { log?.debug?.(msg) } catch { /* 日志出口不吃崩主链 */ } }
  const warn = (msg) => { try { log?.warn?.(msg) } catch {} }
  const stage = (name, ms) => { try { reportStage?.(name, ms) } catch {} }

  /** G4 自报口径同 mw-persona：注入 reportStage 走 clock；否则 traceStage（无 tracing 退化直执行）。 */
  async function timed(ctx, name, fn) {
    if (reportStage) {
      const t0 = clock()
      try {
        return await fn()
      } finally {
        stage(name, clock() - t0)
      }
    }
    return traceStage(ctx, name, fn)
  }

  /** 路由结果写 state（观测位）；裸 ctx 无 state 不吃崩主链。 */
  function record(ctx, outcome, cmd, extra) {
    try {
      ctx?.state?.set?.(COMMAND_ROUTER_KEY, {
        outcome,
        command: cmd ? String(cmd.name ?? '') : '',
        arg: cmd ? String(cmd.arg ?? '') : '',
        at: clock(),
        ...(extra || {}),
      })
    } catch { /* state 槽位缺失：观测位让位于主链 */ }
  }

  /** 本轮入队增量探测：queue getter 现返回冻结快照（review A2 契约），只读长度。 */
  function queueLength(ctx) {
    const q = ctx?.reply?.queue
    return Array.isArray(q) ? q.length : null
  }

  async function router(ctx, next) {
    // 1) 判定段：parse 注入面决定「是不是归本层管的命令」。异常 fail-open 透传——
    //    legacy 命令闸门对同一事件复检，错放不产生越权（非主人/带附件等都在
    //    parse 内拦，拦不住还有 legacy 兜拦），错杀一条命令才产生行为差。
    let parsed = null
    try {
      parsed = await timed(ctx, 'router', async () =>
        (typeof parse === 'function' ? parse(ctx) : null))
    } catch (error) {
      counters.parseErrors += 1
      dbg(`router: 命令解析抛错，按 fail-open 透传 legacy（${error?.message ?? error}）`)
      record(ctx, 'parse-error', null, { reason: String(error?.message ?? error) })
      return next()
    }
    if (!parsed || !parsed.cmd || !parsed.cmd.name) {
      counters.passthrough += 1
      record(ctx, 'no-command')
      return next()
    }

    // 2) 适配面：handlers 表只登记「可外部调用」的命令（覆盖矩阵的代码形态）。
    //    未登记的（ext 模块命令 / 依赖 hub 闭包内部状态类）→ 透传 legacy，不假接管。
    const cmd = parsed.cmd
    const msg = parsed.msg
    counters.matched += 1
    const handler = handlers[cmd.name]
    if (typeof handler !== 'function') {
      counters.noHandler += 1
      dbg(`router: 命令 /${cmd.name} 未适配（不在覆盖矩阵接管列），透传 legacy`)
      record(ctx, 'no-handler', cmd)
      return next()
    }

    // 3) 执行段：runWithContext 包住——host 侧 handler 经由旧发送面
    //    （hub.sendSegments → 出口切换包装器）回复时靠 ALS 认领本轮 ctx 落
    //    ctx.reply.enqueue；不在 ALS 里跑，live 模式会绕过收口直接发包（拍板禁止）。
    //    回滚判据用入队增量：错误发生在「已 enqueue 之后」时，残留条目若随
    //    透传双发，就成了「半途回复 + legacy 回复」两条——先截回 before 水位。
    const before = queueLength(ctx)
    let error = null
    try {
      await timed(ctx, 'router-handler', () => runWithContext(ctx, () => handler(cmd, msg, ctx)))
    } catch (e) {
      error = e
    }
    if (error) {
      counters.handlerErrors += 1
      try {
        const now = queueLength(ctx)
        if (before !== null && now !== null && now > before) {
          if (typeof ctx.reply.rollbackTo === 'function') ctx.reply.rollbackTo(before)
          else ctx.reply.queue.length = before // 旧 duck reply 兼容位（自定义注入面）
        }
      } catch { /* 非标准 reply（无 queue 槽）：无增量可回滚，维持现状透传 */ }
      warn(`router: 命令 /${cmd.name} 执行出错，回滚半途回复并透传 legacy 兜底（${error?.message ?? error}）`)
      record(ctx, 'handler-error', cmd, { reason: String(error?.message ?? error) })
      return next()
    }

    // 4) 接管判据：本轮入队有增量 → 终端短路（不调 next()）；零增量复刻
    //    legacy「空回复继续当聊天」。
    const after = queueLength(ctx)
    const grew = before === null || after === null ? true : after > before
    if (!grew) {
      counters.fellThrough += 1
      record(ctx, 'fell-through', cmd)
      return next()
    }
    counters.intercepted += 1
    record(ctx, 'intercepted', cmd)
    // 终端短路：persona/memory/aggregator/legacy 一律不进；外层 bubble 正常收尾。
    return undefined
  }

  router.stats = () => ({ ...counters })
  return router
}
