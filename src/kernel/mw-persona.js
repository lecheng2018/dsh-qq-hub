// 人设注入器中间件（RFC-0001 §4 Phase 3 / US-010；docs/rfc0001-mapping.md §4「人设/记忆装配 → Context Assembly」）。
//
// 按 ctx.inbound 归聊（group:<gid> / private:<uid>，口径与 mw-ratelimit.chatKeyFromInbound
// 一致）解析当前人设配置，装配结果写 ctx.state（PERSONA_KEY，symbol 键与业务 string 键天然隔离）。
// 人设源经 getPersona 注入面**每事件实时读取**——不缓存、不持旧引用，面板改卡后下一事件即生效（热重载，零重启）。
//
// 接管面定位（如实记录，controller 拍板 hub.js 红线不动）：
//   - 旧核心的人设选择是 hub **内部直读** personas.js（hub.js:34 import personaIdFor/readPersona，
//     mount 处遮蔽 {{qq_hub_persona}} 变量），**不走 createHub 注入面**——装配层包不出接管点。
//   - 因此本中间件在 pipeline 态是「预取 + 打点」：state 里的人设快照供观测与 Phase 4 消费
//     （Phase 4 换 ModelInferenceExecutor 时由装配层供给，届时 hub 直读段退役）；
//     本轮实际提示词人设仍由 hub 直读（值与 state 快照同源同 cfg，语义一致）。
//   - 记忆的接管点在 mw-memory（contextProviders provider 包装），与本件不同面。
//
// fail-closed 纪律（对齐 mw-acl / 记忆作用域硬锁）：不可归聊的事件、人设源未接、读取抛错
// ——一律写空装配（degraded 记录）且**绝不炸管道**（继续 next），只留 debug 与计数。
// Phase 3 的装配结果不接管 hub 直读面，flag-off / 未装本件时行为与 US-009 逐字节一致。
//
// G4 打点（US-004 移交口径）：段名 'persona'；注入 reportStage 走 clock 恰好一次，
// 缺省 traceStage，未装 tracing 自动退化直执行（同 mw-ratelimit/mw-aggregator 约定）。

import { traceStage } from './mw-tracing.js'

/** ctx.state 上人设装配快照的键（symbol 隔离；Phase 4 消费位）。 */
export const PERSONA_KEY = Symbol.for('dsh-qq-hub.kernel.persona')

/** 事件 → hub 同款 chat 对象（personaIdFor / memory.contextFor 消费的形状）；不可归聊返回 undefined。 */
export function chatFromInbound(inbound) {
  if (inbound?.groupId) {
    const userId = String(inbound?.sender?.userId ?? '')
    return {
      chatId: `group:${inbound.groupId}`,
      kind: 'group',
      groupId: String(inbound.groupId),
      ...(userId ? { userId } : {}),
    }
  }
  const userId = String(inbound?.sender?.userId ?? '')
  if (userId && inbound?.subType !== 'group') {
    return { chatId: `private:${userId}`, kind: 'private', userId }
  }
  return undefined
}

/**
 * 人设注入器工厂。
 *
 * @param {object} [options]
 * @param {(chat: {chatId: string, kind: string, userId?: string, groupId?: string}, inbound: any) => any} [options.getPersona]
 *   人设源（**注入面**）：按 chat 解析当前人设配置，返回 { id?, name?, body? }（或字符串=正文）。
 *   每次事件实时调用 = 天然热重载；缺省未接 → 一律空装配（degraded）。装配层用
 *   personaIdFor + readPersona + getConfig 闭包接线（复用 persona 模块现成读取函数）。
 * @param {{ debug?: Function, warn?: Function }} [options.log]
 * @param {(name: string, ms: number) => any} [options.reportStage] G4 分段自报覆盖位（段名 'persona'）
 * @param {() => number} [options.clock] 毫秒时钟（缺省 Date.now；测试注入假时钟，同时供 reportStage 计时）
 * @returns {((ctx: any, next: () => Promise<void>) => Promise<void>) & { stats(): object }}
 */
export function createPersonaInjector(options = {}) {
  const { getPersona, log, reportStage, clock = () => Date.now() } = options

  const counters = { injected: 0, degraded: 0, errors: 0 }
  const dbg = (msg) => { try { log?.debug?.(msg) } catch { /* 日志出口不吃崩主链 */ } }
  const stage = (name, ms) => { try { reportStage?.(name, ms) } catch {} }

  /** G4 自报口径同 mw-ratelimit：注入 reportStage 走 clock；否则 traceStage（无 tracing 退化直执行）。 */
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

  /** 装配失败的空快照：ok=false + degraded，永远写 state（消费面据此区分「没装配」与「装配了但失败」）。 */
  function degradedRecord(chat, reason) {
    return {
      ok: false,
      degraded: true,
      reason: String(reason || 'unknown'),
      chatId: chat?.chatId ?? '',
      kind: chat?.kind ?? '',
      id: '',
      name: '',
      body: '',
      at: clock(),
    }
  }

  async function persona(ctx, next) {
    const chat = chatFromInbound(ctx?.inbound)
    let record
    if (!chat) {
      // 不可归聊（无 sender 的 notice / request 等）：不知道该给谁配人设，空装配（fail-closed）
      counters.degraded += 1
      record = degradedRecord(chat, 'unresolved-chat')
    } else if (typeof getPersona !== 'function') {
      counters.degraded += 1
      record = degradedRecord(chat, 'no-persona-source')
      dbg('persona: 未接人设源（getPersona），写空装配')
    } else {
      try {
        const raw = await timed(ctx, 'persona', () => getPersona(chat, ctx.inbound))
        // getPersona 允许返回对象或字符串（字符串按正文处理，id/name 留空由消费方兜底）
        const r = typeof raw === 'string' ? { body: raw } : raw && typeof raw === 'object' ? raw : null
        if (!r) throw new Error('人设源没给出可用配置')
        record = {
          ok: true,
          degraded: false,
          chatId: chat.chatId,
          kind: chat.kind,
          id: String(r.id ?? ''),
          name: String(r.name ?? ''),
          body: typeof r.body === 'string' ? r.body : '',
          at: clock(),
        }
        counters.injected += 1
      } catch (error) {
        // fail-closed：解析失败写空装配、不炸管道——装配层的错不能吃掉本轮回复链
        counters.errors += 1
        record = degradedRecord(chat, 'persona-source-error')
        dbg(`persona: ${chat.chatId} 解析人设出错，按 fail-closed 写空装配（${error?.message ?? error}）`)
      }
    }
    try { ctx?.state?.set?.(PERSONA_KEY, record) } catch { /* 裸 ctx 无 state：观测位缺失，主链不受影响 */ }
    await next()
  }

  persona.stats = () => ({ ...counters })
  return persona
}
