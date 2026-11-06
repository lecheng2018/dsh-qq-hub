// 入口权限中间件（RFC-0001 §2.1 拓扑 Tracing→RateLimiter→ACL→Dedup→终端 / §4 Phase 2，US-009）。
//
// 判定**复用不复制**：白名单/owner 直通走 src/chat/access.js 的 checkAllowed 与 isOwner，
// 与 hub.js:1324 旧核心用的是同一份函数、同一份 cfg——本层只是把「注定被旧核心忽略的
// 流量」提前短路，判定结果对齐旧核心，不做第二个权威。
//
// 只管 message 大类：poke/notice/request 等事件在旧核心本就没有白名单闸门（onPoke 先记
// interaction 再合成消息交给 onMessage 复检），入口层拦它们属于行为变更，一律放行。
// 群「开关」口径即 cfg.allow.groups 的默认拒绝白名单（不在名单 = 该群不可说话），无需
// 第二道布尔；group-policy.js 的导出刻意不做入口闸门——decideGroupReply 是回复策略
// （吃 rand、冷却、群状态计数），不是访问判定，入口再调一次会与核心双判定并消耗两次
// 随机数。「宁可少拦，不可错拦」由核心复检兜底：owner 群聊直通粗筛后旧核心仍按
// checkAllowed 把关，不会产生越权回复。
//
// **fail-closed 拍板（controller）**：判定函数抛错（配置损坏/注入桩坏）→ 拒绝并
// abort('acl')。权限防御与资源防御（ratelimit/dedup 的 fail-open）刻意相反：
// 放过未授权说话者是隐私事故，错拦一条正常消息只是少回一句——对齐本仓记忆作用域
// fail-closed 的硬锁纪律（判定异常绝不能当通行）。
//
// 拒绝事件 ctx.abort('acl') 且不调 next()：其后各级两级不进（compose §2.2 / US-008a），
// 只有外层 tracing 的 bubble 正常收尾打点。

import { checkAllowed, isOwner } from '../chat/access.js'
import { traceStage } from './mw-tracing.js'

/**
 * 缺省判定：ctx.inbound → { allow, reason }。字段口径对齐 parseMessageEvent 交给
 * checkAllowed 的 msg（kind/userId/groupId），owner 直通复用 isOwner。
 * @param {any} ctx
 * @param {any} cfg 插件配置（host 注入实时 getConfig() 的结果）
 * @returns {{ allow: boolean, reason: string }}
 */
export function defaultAclDecision(ctx, cfg) {
  const inbound = ctx?.inbound
  if (inbound?.type !== 'message') return { allow: true, reason: '非 message 事件不设白名单闸门（同旧核心）' }
  const kind = inbound.groupId ? 'group' : 'private'
  const userId = String(inbound.sender?.userId ?? '')
  if (isOwner(cfg || {}, userId)) return { allow: true, reason: 'owner 直通' }
  const r = checkAllowed(cfg || {}, { kind, userId, groupId: kind === 'group' ? String(inbound.groupId) : '' })
  return { allow: r.allowed === true, reason: String(r.reason ?? '') }
}

/**
 * 入口 ACL 中间件工厂。
 *
 * @param {object} [options]
 * @param {() => any} [options.getConfig] 配置源（host 注入 () => cfg 实时值）；缺省判定消费之
 * @param {(ctx: any) => { allow?: boolean, reason?: string } | undefined} [options.decide]
 *   判定注入面（测试桩 / 未来风控扩展）：给了就完全替代缺省判定；
 *   返回值 allow !== true 一律视为拒绝
 * @param {{ debug?: Function, warn?: Function }} [options.log]
 * @param {(name: string, ms: number) => any} [options.reportStage] G4 分段自报覆盖位（段名 'acl'）；
 *   缺省走 traceStage，未装 tracing 时自动退化
 * @param {() => number} [options.clock] reportStage 计时用毫秒时钟（缺省 Date.now）
 * @returns {((ctx: any, next: () => Promise<void>) => Promise<void>) & { stats(): object }}
 */
export function createAclMiddleware(options = {}) {
  const { getConfig, decide, log, reportStage, clock = () => Date.now() } = options

  const counters = { passed: 0, rejected: 0, decideErrors: 0 }

  const dbg = (msg) => { try { log?.debug?.(msg) } catch { /* 日志出口不吃崩主链 */ } }
  const warn = (msg) => { try { log?.warn?.(msg) } catch {} }
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

  async function acl(ctx, next) {
    let verdict = null
    let thrown = null
    try {
      verdict = await timed(ctx, 'acl', async () =>
        (decide ? decide(ctx) : defaultAclDecision(ctx, typeof getConfig === 'function' ? getConfig() : {})))
    } catch (error) {
      thrown = error
    }
    // fail-closed：判定抛错与显式拒绝同路——都是 abort('acl')
    if (thrown || !verdict || verdict.allow !== true) {
      if (thrown) {
        counters.decideErrors += 1
        warn(`acl: 判定异常，按 fail-closed 拒绝（${thrown?.message ?? thrown}）`)
      } else {
        dbg(`acl: ${verdict?.reason ?? '判定缺 allow'}——入口拒绝`)
      }
      counters.rejected += 1
      try { ctx.abort('acl') } catch { /* 裸 ctx 无 abort 槽：不因此炸链 */ }
      return
    }
    counters.passed += 1
    await next()
  }

  acl.stats = () => ({ ...counters })
  return acl
}
