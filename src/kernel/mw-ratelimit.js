// 入口限流中间件（RFC-0001 §2.1 拓扑 Tracing→RateLimiter→ACL→Dedup→终端 / §4 Phase 2，US-009）。
//
// 令牌桶 per-key（缺省按 hub 同款 chatId 口径 group:<gid>/private:<uid>，键函数可注入）：
// 容量 capacity 决定突发上限，refillPerSec 决定持续速率。超限事件 ctx.abort('ratelimited')
// 且**不调 next()**——按 compose §2.2（US-008a）语义，其后 ACL/Dedup/出口链/聚合/终端
// 两级都不进，只有外层 tracing 的 bubble 正常回溯收尾打点；出口链根本不为无效流量记账。
//
// **fail-open 拍板（controller）**：键推导/时钟等判定异常属资源防御故障——错拦正常
// 流量的代价大于漏拦一次刷屏，异常一律放行并计 errors 数留 debug；与 mw-acl 的
// fail-closed（权限防御，判定坏了不能当通行）刻意相反，两边的注释各自写明理由。
//
// capacity/refillPerSec 为构造参数：缺省给保守值（30 突发 + 5/秒持续，人类节奏远用不满，
// 脚本刷屏必撞墙），这是 Phase 2 验收旋钮，实测调参在验收阶段做；配置化（US-012）走环境
// 变量 QQHUB_RL_CAPACITY / QQHUB_RL_REFILL_PER_SEC（见 ratelimitOptionsFromEnv，非法值回
// 构造缺省——口径与四个管道开关一致：不确定就用默认）。桶表另设 LRU 上限 maxKeys 防止 chatId 无界增长——被逐出的桶按
// 「新桶」复活，代价仅是多一次突发额度，不会丢消息。

import { traceStage } from './mw-tracing.js'

/** 事件 → hub 同款 chatId 口径（与 mw-aggregator.chatIdFromInbound 一致）；不可归聊返回 undefined。 */
function chatKeyFromInbound(inbound) {
  if (inbound?.groupId) return `group:${inbound.groupId}`
  const userId = String(inbound?.sender?.userId ?? '')
  if (userId && inbound?.subType !== 'group') return `private:${userId}`
  return undefined
}

/**
 * 令牌桶限流中间件工厂。
 *
 * @param {object} [options]
 * @param {number} [options.capacity=30] 桶容量（突发上限）；Phase 2 验收旋钮，配置化留 US-012
 * @param {number} [options.refillPerSec=5] 每秒补充令牌数；同上
 * @param {number} [options.maxKeys=4096] 桶表 LRU 上限（内存防线，被逐出按新桶复活）
 * @param {() => number} [options.clock] 毫秒时钟（缺省 performance.now 单调；测试注入假时钟）
 * @param {(inbound: any, ctx: any) => string | undefined} [options.keyFn] 限流键推导，undefined = 放行
 * @param {{ debug?: Function, warn?: Function }} [options.log]
 * @param {(name: string, ms: number) => any} [options.reportStage] G4 分段自报覆盖位（段名 'ratelimit'）；
 *   缺省走 mw-tracing 的 traceStage，未装 tracing 时自动退化为直执行
 * @returns {((ctx: any, next: () => Promise<void>) => Promise<void>) & { stats(): object }}
 */
export function createRatelimitMiddleware(options = {}) {
  const {
    capacity = 30,
    refillPerSec = 5,
    maxKeys = 4096,
    // 默认单调时钟（review R1：Date.now 会被系统回拨/恢复重复补令牌；performance.now
    // 单调不减。注入假时钟仍允许，但 take() 内对回拨做基线不回退保护）
    clock = () => performance.now(),
    keyFn = chatKeyFromInbound,
    log,
    reportStage,
  } = options
  // review R2：capacity < 1 时每次消费 1 枚永远放行不了——必须 ≥ 1；maxKeys 取整防呆
  if (!Number.isFinite(capacity) || capacity < 1) throw new TypeError('ratelimit: capacity 必须为有限数且至少为 1')
  if (!Number.isFinite(refillPerSec) || refillPerSec < 0) throw new TypeError('ratelimit: refillPerSec 必须为非负数')
  if (!Number.isInteger(maxKeys) || maxKeys <= 0) throw new TypeError('ratelimit: maxKeys 必须为正整数')

  /** 限流键 → { tokens, at }；Map 插入序即 LRU 序（touch 靠 delete+set 重排）。 */
  const buckets = new Map()
  const counters = { passed: 0, limited: 0, keyless: 0, errors: 0 }

  const dbg = (msg) => { try { log?.debug?.(msg) } catch { /* 日志出口不吃崩主链 */ } }
  const stage = (name, ms) => { try { reportStage?.(name, ms) } catch {} }

  /** G4 自报口径同 mw-egress/mw-aggregator：注入 reportStage 走 clock；否则 traceStage（无 tracing 退化直执行）。 */
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

  /**
   * 取一枚令牌：true = 放行（已扣减），false = 超限。
   * review R1/R2 修复：
   *  - 时钟必须有限，NaN 在**改动桶状态之前**抛出（外层 catch 走 fail-open，桶不被毒化、errors 计数）；
   *  - 注入时钟回拨时基线不回退（effectiveNow = max(now, b.at)），同一段墙上时间不被重复计息。
   */
  function take(key) {
    const now = clock()
    if (!Number.isFinite(now)) throw new TypeError('ratelimit: clock 必须返回有限毫秒数')
    let b = buckets.get(key)
    if (b) {
      const effectiveNow = Math.max(now, b.at)
      const dt = (effectiveNow - b.at) / 1000
      b.tokens = Math.min(capacity, b.tokens + dt * refillPerSec)
      b.at = effectiveNow
      buckets.delete(key)
      buckets.set(key, b) // LRU touch：热桶不被逐
    } else {
      b = { tokens: capacity, at: now }
      buckets.set(key, b)
      if (buckets.size > maxKeys) {
        const oldest = buckets.keys().next().value
        if (oldest !== key) buckets.delete(oldest)
      }
    }
    if (b.tokens >= 1) {
      b.tokens -= 1
      return true
    }
    return false
  }

  async function ratelimit(ctx, next) {
    let allowed = true
    let limitedKey
    let keyless = false
    try {
      const key = await timed(ctx, 'ratelimit', async () => keyFn(ctx.inbound, ctx))
      if (key === undefined || key === null || key === '') {
        // 不可归聊的事件（无 sender 的 notice 等）：不知道该拦谁，放行不误伤整链
        keyless = true
      } else {
        allowed = take(String(key))
        if (!allowed) limitedKey = String(key)
      }
    } catch (error) {
      // fail-open 拍板：判定故障不吃消息，见文件头理由
      counters.errors += 1
      allowed = true
      dbg(`ratelimit: 判定异常，按 fail-open 放行（${error?.message ?? error}）`)
    }
    if (!allowed) {
      counters.limited += 1
      dbg(`ratelimit: ${limitedKey} 令牌耗尽（capacity=${capacity}，refill=${refillPerSec}/s），abort('ratelimited')`)
      try { ctx.abort('ratelimited') } catch { /* 裸 ctx 无 abort 槽：不因此炸链 */ }
      return
    }
    if (keyless) counters.keyless += 1
    counters.passed += 1
    await next()
  }

  ratelimit.stats = () => ({
    ...counters,
    keys: buckets.size,
    capacity,
    refillPerSec,
  })
  return ratelimit
}

/**
 * 限流旋钮的环境变量解析（US-012 配置化尾巴，host.js 装配处消费）。
 *
 * - `QQHUB_RL_CAPACITY`      桶容量（突发上限），正数才有效；
 * - `QQHUB_RL_REFILL_PER_SEC` 每秒补令牌数，非负数才有效（0 = 突发用尽后全拒，极端闸）。
 *
 * 非法值（乱码/负数/空串/未设置）**返回不含该键的对象** → 工厂解构落到构造缺省 30/5。
 * 熔断语义与四个管道开关同款：不确定就用默认，绝不因环境变量写错而炸装配。
 * 改 env 需重启进程（装配期一次性读取，与开关口径一致）。
 *
 * @param {Record<string, string | undefined>} [env] 缺省 process.env（测试注入桩 env）
 * @returns {{ capacity?: number, refillPerSec?: number }} 可直接 spread 进 createRatelimitMiddleware
 */
export function ratelimitOptionsFromEnv(env = process.env) {
  const out = {}
  // 空串/纯空白先拦：Number('') === 0 会被当成合法数值（capacity 恰好因此误过 0 判、
  // refill 更会落进「极端闸 0」），与「未设置=用默认」的语义相反，必须先短路。
  const rawC = env?.QQHUB_RL_CAPACITY
  if (typeof rawC === 'string' && rawC.trim() !== '') {
    const capacity = Number(rawC)
    if (Number.isFinite(capacity) && capacity >= 1) out.capacity = capacity
  }
  const rawR = env?.QQHUB_RL_REFILL_PER_SEC
  if (typeof rawR === 'string' && rawR.trim() !== '') {
    const refill = Number(rawR)
    if (Number.isFinite(refill) && refill >= 0) out.refillPerSec = refill
  }
  return out
}
