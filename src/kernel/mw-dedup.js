// 入口幂等去重中间件（RFC-0001 §2.1 拓扑 Tracing→RateLimiter→ACL→Dedup→终端 / §4 Phase 2，US-009）。
//
// messageId 幂等缓存：Map 插入序实现的 LRU（零依赖，命中即 touch 重排，满员逐出最旧），
// 容量缺省 2048（构造参数——Phase 2 验收旋钮，配置化留 US-012 文档化）。重传事件
// ctx.abort('duplicate') 且不调 next()：终端绝不二次执行——「重传只处理一次」的落点位。
// 按 compose §2.2（US-008a），其后各级两级不进，外层 bubble 正常收尾。
//
// 无 messageId 的事件（poke/notify 等通知类）放行并计 keyless：幂等对它们没有语义，
// 不据此拦截。判定异常 fail-open（拍板同 ratelimit：资源防御，错拦代价大于漏拦）。
//
// 2026-11-07 review P0 D1/P1 D2 修复：旧实现「先写缓存后下行」且无失败回滚——
// 下游抛错后重传被永久拦死（数据丢失级）。现拆为两层：**处理中键**（inProgress，
// next() 期间占用，不进 LRU、不逐出，异常/abort 即释放）与**成功缓存**（seen，
// next() 正常完成且未 abort 才写入）。语义从「一个缓存周期内最多准入一次」修正为
// 「成功处理一次」；失败后重传可重新准入。
//
// 缺省键 = (聊天域|messageId) 复合，而非裸 messageId：同域同 id 才是重传；跨聊天撞 id
// 按碰撞不放行处理。对齐 host.js seenIds.add(chatKey, message_id) 的既有记账口径，同时
// 避免随机 message_id 环境（e2e 取样 1e6 空间）跨聊天撞号错杀正常消息。键函数可注入，
// 需要纯 messageId 幂等口径的调用方自配。

import { traceStage } from './mw-tracing.js'

/** 事件 → 去重键：无 messageId 返回 undefined（放行）；有则按聊天域复合。 */
function dedupKeyFromInbound(inbound) {
  const mid = inbound?.messageId
  if (mid === undefined || mid === null || mid === '') return undefined
  const groupId = inbound?.groupId
  const hasGroup = groupId !== undefined && groupId !== null && groupId !== ''
  if (hasGroup) return JSON.stringify(['message', 'group', String(groupId), String(mid)])
  // 群事件缺 groupId：域不可信，宁 keyless 放行也不把不同事件强汇进 '-' 域（review D3）
  if (inbound?.subType === 'group') return undefined
  const userId = inbound?.sender?.userId
  if (userId === undefined || userId === null || userId === '') return undefined
  return JSON.stringify(['message', 'private', String(userId), String(mid)])
}

/**
 * 入口幂等去重中间件工厂。
 *
 * @param {object} [options]
 * @param {number} [options.capacity=2048] LRU 容量；Phase 2 验收旋钮，配置化留 US-012
 * @param {(inbound: any, ctx: any) => string | undefined} [options.keyFn] 去重键推导，undefined = 放行
 * @param {{ debug?: Function }} [options.log]
 * @param {(name: string, ms: number) => any} [options.reportStage] G4 分段自报覆盖位（段名 'dedup'）；
 *   缺省走 traceStage，未装 tracing 时自动退化
 * @param {() => number} [options.clock] reportStage 计时用毫秒时钟（缺省 Date.now）
 * @returns {((ctx: any, next: () => Promise<void>) => Promise<void>) & { stats(): object }}
 */
export function createDedupMiddleware(options = {}) {
  const { capacity = 2048, keyFn = dedupKeyFromInbound, log, reportStage, clock = () => Date.now() } = options
  if (!Number.isInteger(capacity) || capacity <= 0) throw new TypeError('dedup: capacity 必须为正整数')

  /** 成功缓存：Map 插入序 = LRU 逐出序，命中 delete+set 重排即 touch。 */
  const seen = new Map()
  /** 处理中键：next() 期间占用。不参与 LRU 逐出（D2：在飞键被逐出=同消息并发执行）；
   *  规模由上游并发与请求生命周期约束，不为省内存牺牲幂等。 */
  const inProgress = new Set()
  const counters = { passed: 0, duplicates: 0, keyless: 0, errors: 0 }

  const dbg = (msg) => { try { log?.debug?.(msg) } catch { /* 日志出口不吃崩主链 */ } }
  const stage = (name, ms) => { try { reportStage?.(name, ms) } catch {} }

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

  /** 成功处理一次后落缓存（幂等 touch + 逐出）。 */
  function rememberSuccess(key) {
    seen.delete(key)
    seen.set(key, true)
    while (seen.size > capacity) seen.delete(seen.keys().next().value)
  }

  async function dedup(ctx, next) {
    let key
    let duplicate = false
    let keyless = false
    try {
      const value = await timed(ctx, 'dedup', async () => keyFn(ctx.inbound, ctx))
      if (value === undefined || value === null || value === '') {
        keyless = true
      } else {
        key = String(value)
        // has+add 之间无 await：本进程内的原子准入点（D2：在飞键并发只放一个）
        if (inProgress.has(key) || seen.has(key)) {
          duplicate = true
          // 命中成功缓存同样 touch LRU（对齐旧 seenBefore 语义：热重传不被逐出后「复活成新消息」）
          if (!inProgress.has(key) && seen.has(key)) {
            seen.delete(key)
            seen.set(key, true)
          }
        } else {
          inProgress.add(key)
        }
      }
    } catch (error) {
      // fail-open 拍板（同 ratelimit）：键推导异常不吃正常消息
      counters.errors += 1
      keyless = true
      dbg(`dedup: 键推导异常，按 fail-open 放行（${error?.message ?? error}）`)
    }
    if (duplicate) {
      counters.duplicates += 1
      dbg("dedup: messageId 命中处理中/成功缓存，判定重传，abort('duplicate')")
      try { ctx.abort('duplicate') } catch { /* 裸 ctx 无 abort 槽：不因此炸链 */ }
      return
    }
    if (keyless) counters.keyless += 1
    counters.passed += 1
    try {
      await next()
      // 成功且未被 abort 才写幂等缓存；abort 的重传留待下次重新准入（D1）
      if (key !== undefined && !ctx?.signal?.aborted) rememberSuccess(key)
    } finally {
      // next() 抛错同样释放处理中占位——失败必须可重试
      if (key !== undefined) inProgress.delete(key)
    }
  }

  dedup.stats = () => ({ ...counters, size: seen.size, inProgress: inProgress.size, capacity })
  return dedup
}
