// 入口合流中间件（RFC-0001 §4 Phase 2 / US-008，G2 中断并合并）——**聚合执行暂停版**。
//
// 2026-11-07 外部双模型 review（dsh-qq-hub-onion-refactor-review.md，B 节 P0 A1/A2）判定：
// 合并信封与终端消费的数据不是同一份——legacy 终端吃的是 ctx.inbound.rawPayload
// （legacy-fallback 终端第一行，lead 原事件同一引用），而 flushWindow 只把合并段写回
// lead.inbound 信封视图；followers 被 abort 后其内容对旧核心**不可见**，即
// 「flag-on 时 follower 消息物理丢失」。本仓旧注释对此有自知（"实测 e2e 开启态
// 7 条用例丢消息/超时"），但自知不等于安全：手动开旗即踩。
// 第二处 P0：lead 被取消时整窗作废，有效 follower 陪葬且不被明确 abort。
//
// 止损拍板（对齐 review 补丁 A）：聚合执行**暂停**——本件退化为逐事件透传，
// 每个入站 ctx 原样下行到终端，不再开窗、不再吞 follower。合流语义仍由
// hub 内部 pending/enqueue/flush 提供（它消费完整事件序列，无此缺陷），
// 行为与 FLAG_INGRESS_AGGREGATOR=false 时一致。
//
// 重新启用聚合的前置条件（review B 节列全，缺一不得恢复吞并实现）：
//   1. 终端直接消费聚合批次（Phase 4 llm-invoker 化后由管道组装回合输入），
//      或提供经协议验证的多消息适配器（rawPayload 重建含 senders/引用/附件）；
//   2. 每个成员事件独立的有效性与完成状态（lead 取消不得销毁 follower）；
//   3. flush 同步阶段建立同 chat 执行占位（消除窗口删除与在飞登记间的空档）；
//   4. timer generation 检查；任意异常路径所有等待者都能收敛；
//   5. dispose 覆盖排队+执行中的全部任务。
// 恢复前应先做 shadow 合流（只记批次不吞输入），比对批次完整性后再灰度。
//
// G2 诚实边界（保留原档，Phase 4 时同样适用）：abort 的生效粒度 = Dispatcher
// 契约的「未 flush 回复不外发 + dropped 计数」；进行中的 LLM/DSH 回合不会被打断。

import { traceStage } from './mw-tracing.js'

/**
 * 入口合流灰度开关：FLAG_INGRESS_AGGREGATOR。
 * 解析口径与 FLAG_USE_PIPELINE / FLAG_EGRESS_SHADOW 一致（仅 'true'/'1' 算开）。
 * 注意：开旗现在只意味着「把暂停版挂进管道」——逐事件透传 + 一次 warn，
 * 不再产生吞并行为。真正的合流语义恢复以上方前置条件为准。
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isIngressAggregatorEnabled(env = process.env) {
  const raw = env?.FLAG_INGRESS_AGGREGATOR
  if (typeof raw !== 'string') return false
  const v = raw.trim().toLowerCase()
  return v === 'true' || v === '1'
}

/** 聚合元数据在 ctx.state 上的键（暂停版不再写入；导出保留供恢复实现与观测复用）。 */
export const AGGREGATION_KEY = Symbol.for('dsh-qq-hub.kernel.aggregation')

/**
 * 入口合流中间件工厂（暂停版：逐事件透传）。
 * options 面与吞并版保持一致（getConfig/log/reportStage/clock），
 * 装配方零改动；恢复实现见 git 历史（US-008b 版本，commit 47a94ab）。
 *
 * @param {object} [options]
 * @param {() => any} [options.getConfig] 保留位（暂停版不消费）
 * @param {{ debug?: Function, warn?: Function }} [options.log]
 * @param {(name: string, ms: number) => any} [options.reportStage] G4 分段自报覆盖位
 * @param {() => number} [options.clock] reportStage 计时用毫秒时钟
 * @returns {((ctx: any, next: () => Promise<void>) => Promise<void>) & { stats(): object, dispose(): void }}
 */
export function createAggregatorMiddleware(options = {}) {
  const { reportStage, clock = () => Date.now(), log } = options

  let disposed = false
  const active = new Set()
  const counters = { disposedAborts: 0 }

  const warn = (msg) => { try { log?.warn?.(msg) } catch { /* 日志出口不吃崩主链 */ } }
  const stage = (name, ms) => { try { reportStage?.(name, ms) } catch { /* 观测失败不挡业务 */ } }

  warn('aggregator: 聚合执行暂停（review P0 A1/A2 止损），逐事件透传；合流仍由 hub 内部 pending 提供')

  function abortCtx(ctx) {
    if (ctx?.signal?.aborted) return
    try {
      ctx.abort('aggregator-disposed')
      counters.disposedAborts++
    } catch { /* 裸 ctx 无 abort 槽 */ }
  }

  async function timed(ctx, fn) {
    if (!reportStage) return traceStage(ctx, 'aggregator-direct', fn)
    let started
    try { started = clock() } catch { /* 时钟坏了不挡业务 */ }
    try {
      return await fn()
    } finally {
      try {
        if (Number.isFinite(started)) {
          const ended = clock()
          if (Number.isFinite(ended)) stage('aggregator-direct', Math.max(0, ended - started))
        }
      } catch { /* 观测异常不吞业务结果 */ }
    }
  }

  async function aggregator(ctx, next) {
    if (disposed) {
      // 卸载后不再放新回合下行：与吞并版 dispose 语义一致（abort 而非静默透传）
      abortCtx(ctx)
      return
    }
    if (ctx?.signal?.aborted) return
    active.add(ctx)
    try {
      await timed(ctx, next)
    } finally {
      active.delete(ctx)
    }
  }

  /** 卸载：拒绝后续回合 + abort 全部在飞 ctx。active 不强行清空，任务实际退出由各自 finally 删除。 */
  aggregator.dispose = () => {
    if (disposed) return
    disposed = true
    for (const ctx of [...active]) abortCtx(ctx)
  }

  aggregator.stats = () => ({
    windows: 0,
    inFlight: active.size,
    pendingTimers: 0,
    mergedRounds: 0,
    steered: 0,
    disposedAborts: counters.disposedAborts,
    lastSteerPendingReplies: 0,
    aggregationSuspended: true,
  })

  return aggregator
}
