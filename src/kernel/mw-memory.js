// 记忆检索器中间件（RFC-0001 §4 Phase 3 / US-010；docs/rfc0001-mapping.md §4「人设/记忆装配 → Context Assembly」）。
//
// 按 ctx.inbound 归聊（chat 形状复用 mw-persona.chatFromInbound，与 hub/contextFor 现消费一致），
// 调 features/memory.js 现行 contextFor(chat, sessionId)（签名已核实：返回字符串；sessionId 仅
// 群聊 speakersOf 档案用，管道 ctx 不持 DSH 会话 id → 传 undefined，speakersOf 对 undefined
// 返回 []，**只减不炸**）与 listFor(scopes)（签名已核实：scopes 为空一律 [] ——现成 fail-closed）。
// 装配结果（短期历史 + 相关记忆文本）写 ctx.state（MEMORY_KEY；symbol 键隔离）。
//
// fail-closed 纪律（记忆作用域硬锁，digest/wiki/memory-scope-fail-closed-isolation）：
//   - 不可归聊（无作用域）/ 记忆模块没起 / 检索抛错 → 一律**空装配** + state 打 degraded 标记
//     （STATE_DEGRADED=true 且记录内 degraded 字段），绝不炸管道、绝不放全量记忆。
//
// 接管点 = 装配层的 provider 包装（createContextProviderTakeover，装进 host.js 的
// contextProviders 注入面；**原 provider 函数本体零改动**）：
//   ALS 里有 ctx、state 已备装配结果、NEW_MEMORY_PIPELINE=true → 直接返回 state 缓存，
//   原 provider 零调用；否则走原 provider 逻辑（=legacy 回退：flag off / 无 ctx /
//   装配未跑，三种情况都回旧路，默认关）。
// 接管面覆盖清单（如实记录，交 verifier/controller）：
//   - 覆盖：provider 链的**全部输出**在命中时被 state 装配替换。当前 state 只装 memory 的
//     contextFor 文本——其余经 api.context 注册的模块（token-guardian/group-admin/
//     multi-parser）贡献在命中路径不再执行（NEW_MEMORY_PIPELINE 默认关；开启前需把这几路
//     并入装配或收窄接管面，Phase 4 议题）。hub.js 红线不动，旧核心挂载段（551 行 provider
//     循环）照常执行、只是被包装层供给数据。
//   - 只预取（无接管点）：人设——hub 内部直读 personas.js，见 mw-persona 头注。
//
// G4 打点：段名 'memory'；注入 reportStage 走 now 恰好一次，缺省 traceStage（同 mw-ratelimit 约定）。

import { traceStage } from './mw-tracing.js'
import { getCurrentContext } from './ctx-store.js'
import { chatFromInbound } from './mw-persona.js'

/** ctx.state 上记忆装配快照的键。 */
export const MEMORY_KEY = Symbol.for('dsh-qq-hub.kernel.memory')
/** ctx.state 上「本轮记忆装配降级」标记键（fail-closed 留痕，消费方据此知空装配是故障不是没记忆）。 */
export const STATE_DEGRADED = Symbol.for('dsh-qq-hub.kernel.memory-degraded')

/**
 * 装配接管开关：NEW_MEMORY_PIPELINE。仅 'true' / '1'（忽略大小写与首尾空白）算开；
 * 'false'、乱值、未设置一律 false（熔断语义，与 FLAG_USE_PIPELINE / FLAG_EGRESS_SHADOW /
 * FLAG_INGRESS_AGGREGATOR 同一套解析风格——非法值按 false，不确定就回旧路）。
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isNewMemoryPipelineEnabled(env = process.env) {
  const raw = env?.NEW_MEMORY_PIPELINE
  if (typeof raw !== 'string') return false
  const v = raw.trim().toLowerCase()
  return v === 'true' || v === '1'
}

/**
 * 记忆检索器工厂。
 *
 * @param {object} [options]
 * @param {{ contextFor?: (chat: any, sessionId?: string) => string, listFor?: (scopes: any, opts?: any) => any[] }} [options.memory]
 *   记忆模块注入面（装配层传 use('memory') 的现成对象；测试传桩）。缺件按 fail-closed 空装配。
 * @param {{ debug?: Function, warn?: Function }} [options.log]
 * @param {(name: string, ms: number) => any} [options.reportStage] G4 分段自报覆盖位（段名 'memory'）
 * @param {() => number} [options.now] 毫秒时钟（缺省 Date.now；测试注入假时钟）
 * @returns {((ctx: any, next: () => Promise<void>) => Promise<void>) & { stats(): object }}
 */
export function createMemoryRetriever(options = {}) {
  const { memory, log, reportStage, now = () => Date.now() } = options

  const counters = { assembled: 0, degraded: 0, errors: 0 }
  const dbg = (msg) => { try { log?.debug?.(msg) } catch { /* 日志出口不吃崩主链 */ } }
  const stage = (name, ms) => { try { reportStage?.(name, ms) } catch {} }

  async function timed(ctx, name, fn) {
    if (reportStage) {
      const t0 = now()
      try {
        return await fn()
      } finally {
        stage(name, now() - t0)
      }
    }
    return traceStage(ctx, name, fn)
  }

  /** 空装配记录：degraded 恒真；接管层照常供给（空文本），legacy 语义由 flag/无记录分支兜底。 */
  function degradedRecord(chat, reason) {
    return {
      ok: false,
      degraded: true,
      reason: String(reason || 'unknown'),
      scopes: [],
      text: '',
      at: now(),
    }
  }

  async function memoryMW(ctx, next) {
    const chat = chatFromInbound(ctx?.inbound)
    const scope = chat?.kind === 'group' ? `group:${chat.groupId}` : chat?.kind === 'private' ? `private:${chat.userId}` : ''
    let record
    if (!chat || !scope) {
      // 无作用域 = 不知道该给谁检索：fail-closed 空装配（绝不退化成全量检索——那是跨聊天泄漏面）
      counters.degraded += 1
      record = degradedRecord(chat, 'unresolved-scope')
    } else if (!memory || (typeof memory.contextFor !== 'function' && typeof memory.listFor !== 'function')) {
      // 记忆模块没起（关闭/替换中）：与旧路径 memory.enabled=false 同形——空贡献
      counters.degraded += 1
      record = degradedRecord(chat, 'memory-unavailable')
      dbg('memory: 记忆模块注入面不可用，按 fail-closed 写空装配')
    } else {
      try {
        const [text, items] = await timed(ctx, 'memory', async () => {
          const t = typeof memory.contextFor === 'function' ? memory.contextFor(chat, undefined) : ''
          const l = typeof memory.listFor === 'function' ? memory.listFor([scope]) : []
          return [String(t ?? ''), Array.isArray(l) ? l : []]
        })
        record = { ok: true, degraded: false, scopes: [scope], text, items, at: now() }
        counters.assembled += 1
      } catch (error) {
        // fail-closed：检索抛错吃空装配，不吃整条管道
        counters.errors += 1
        record = degradedRecord(chat, 'retrieval-error')
        dbg(`memory: ${scope} 检索出错，按 fail-closed 写空装配（${error?.message ?? error}）`)
      }
    }
    try {
      ctx?.state?.set?.(MEMORY_KEY, record)
      if (record.degraded) ctx?.state?.set?.(STATE_DEGRADED, true)
    } catch { /* 裸 ctx 无 state：主链不受影响 */ }
    await next()
  }

  memoryMW.stats = () => ({ ...counters })
  return memoryMW
}

/**
 * 装配层 provider 包装（接管点本体；host.js 把它放进 contextProviders，原 provider 本体零改动）。
 *
 * 命中三条件缺一不可：ALS 有 ctx ∧ ctx.state 有 MEMORY_KEY 装配记录 ∧ NEW_MEMORY_PIPELINE 开。
 * 任一不满足 → 原 provider 逻辑（legacy 回退路径：flag-off 装配期可直接不包，此处双保险）。
 *
 * @param {object} options
 * @param {(args: {chat: any, sessionId?: string}) => any} options.provider 原 contextProvider（零改动引用）
 * @param {(env?: Record<string, string | undefined>) => boolean} [options.isNewPipeline] 开关解析（缺省读进程 env，每调用实时读=天然热改）
 * @param {Record<string, string | undefined>} [options.env] 透传给开关解析的 env 表（测试注入）
 * @param {{ debug?: Function }} [options.log]
 * @returns {(args: {chat: any, sessionId?: string}) => any}
 */
export function createContextProviderTakeover(options = {}) {
  const { provider, isNewPipeline = isNewMemoryPipelineEnabled, env, log } = options
  if (typeof provider !== 'function') throw new TypeError('takeover: provider 必须是函数')
  return (args) => {
    try {
      const ctx = getCurrentContext()
      if (ctx && typeof ctx.state?.get === 'function' && ctx.state.has(MEMORY_KEY) && isNewPipeline(env)) {
        const rec = ctx.state.get(MEMORY_KEY)
        const text = rec && typeof rec.text === 'string' ? rec.text : ''
        try { log?.debug?.(`memory-takeover: 命中 state 装配（${rec?.degraded ? 'degraded' : 'ok'}，${text.length} 字）`) } catch {}
        return text
      }
    } catch (error) {
      // 接管层自己的判定故障绝不能影响供给：回原路
      try { log?.debug?.(`memory-takeover: 判定异常，回落原 provider（${error?.message ?? error}）`) } catch {}
    }
    return provider(args)
  }
}
