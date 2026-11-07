// Context 的隐式传递（RFC-0001 §4 Phase 1 / US-007）。
//
// 出口切换要能让「旧核心深处的发送」找到本轮 ctx——可 hub 的调用链上根本没有 ctx 参数，
// 改签名就等于改 hub 逻辑语义（红线）。node:async_hooks 的 AsyncLocalStorage 是唯一零侵入
// 的办法：legacyFallback 用 runWithContext(ctx, 旧入口) 包一次，run 期内创建的 Promise 链
// 与 setTimeout 都自动继承这份 store（Node 内置行为，测试里钉死），深处的 hooks.send /
// onebot.call 于是拿得到 getCurrentContext()。
//
// 边界纪律：管道回溯段（mw-egress 清洗 → Dispatcher 下发）跑完就把 ctx 标成「已收口」。
// 之后从同一条异步链晚到的发送（hub 里的延迟定时器、后台任务）不再投进这个已经排空的
// 队列，而是一律回落旧通道直发——宁可多发一条，也绝不把消息静默吞在死队列里。

import { AsyncLocalStorage } from 'node:async_hooks'

/** 全进程唯一的一个 store：每轮事件各自 run，互不串味。 */
export const ctxStore = new AsyncLocalStorage()

/*
 * 「出口边界已收口」标记：模块私有 WeakSet（review A3#2：旧版存 ctx.state，
 * 裸 ctx / state.set 抛错会静默丢标记，晚到发送再入死队列）。WeakSet 记录 ctx
 * 对象本身不阻碍回收；前提是每轮事件独立 ctx——管道契约如此（createContext 每事件一次）。
 */
const flushedContexts = new WeakSet()

function isContextObject(ctx) {
  return ctx !== null && (typeof ctx === 'object' || typeof ctx === 'function')
}

/**
 * 用 ctx 包裹一次执行并原样返回其结果。同步返回值的 Promise 与 run 期内新建的
 * async resource（定时器、then 链）都带上这份 store。
 * ctx 为空 = **显式退出上下文**（review A3#1：旧版直接 fn() 在 A 的 run 内调用会
 * 继承 A 的 ctx，使「无上下文执行」的后台任务把消息投进 A 的死队列）——改用
 * ctxStore.exit(fn)：同步返回或抛错后恢复外层 store，回调内新建的异步资源保持无上下文。
 * @param {any} ctx 洋葱 Context
 * @param {() => any} fn 被包裹的执行体（旧入口）
 * @returns {any} fn 的返回值
 */
export function runWithContext(ctx, fn) {
  if (typeof fn !== 'function') return undefined
  if (ctx == null) return ctxStore.exit(fn)
  return ctxStore.run(ctx, fn)
}

/**
 * 当前异步上下文里的 ctx；不在事件链路里（B 站 duty、面板接口、调度器后台任务）返回 null。
 * 只做最小 duck 判定：必须有 reply.enqueue，否则宁可当没上下文走旧通道。
 * @returns {any | null}
 */
export function getCurrentContext() {
  const ctx = ctxStore.getStore()
  if (!ctx || typeof ctx.reply?.enqueue !== 'function') return null
  return ctx
}

/**
 * 标记本轮出口边界已收口（幂等）。mw-egress + Dispatcher 跑完后由 flush 中间件调用。
 * @param {any} ctx
 */
export function markContextFlushed(ctx) {
  // 幂等；非对象入参静默忽略（调用方拿 null 守卫在前）
  if (isContextObject(ctx)) flushedContexts.add(ctx)
}

/**
 * 本轮出口是否已过边界（晚到的发送必须回落旧通道直发）。
 * @param {any} ctx
 * @returns {boolean}
 */
export function isContextFlushed(ctx) {
  return isContextObject(ctx) && flushedContexts.has(ctx)
}

/**
 * 影子开关解析：FLAG_EGRESS_SHADOW。'true' / '1'（忽略大小写与首尾空白）算 shadow
 * （新旧双算 + hash 比对），其余（含未设置与乱值）一律 live。
 * 与 legacy-fallback.isPipelineEnabled 同一套取值口径，避免两个开关两种写法。
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isEgressShadowEnabled(env = process.env) {
  const raw = env?.FLAG_EGRESS_SHADOW
  if (typeof raw !== 'string') return false
  const v = raw.trim().toLowerCase()
  return v === 'true' || v === '1'
}
