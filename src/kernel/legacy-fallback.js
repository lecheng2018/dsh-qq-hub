// 遗留核心终端化与熔断开关（RFC-0001 §4 Phase 0 / US-003）。
//
// 绞杀者模式的第一步：不改旧核心一个字，而是把 hub 整体包成洋葱管道的
// 「终端中间件」（Terminal Middleware）。FLAG_USE_PIPELINE 打开时，onebot
// 实时事件先走 compose([tracing 占位, 本终端])，由本终端把事件**原样**
// 送回旧入口（hub.onMessage / hub.onPoke）；关掉时 host 直走旧入口，
// 与重构前逐字节等价。后续 Phase 的中间件从管道外层逐层蚕食 hub 职责。
//
// Phase 0 边界（详见 docs/rfc0001-mapping.md）：
//   - 开关只接管 host.js handleEvent 的 onebot 实时事件流；
//   - backfill 补收（hub.onMessage 带 legacy 专属 opts）、deliver/pushToSession
//     等旁路入口不经过管道，维持直调；
//   - 信封构造是「事件 → InboundEnvelope」的单向适配，旧入口实际消费的是
//     rawPayload（原事件引用），缺字段置 undefined 不臆造。

import crypto from 'node:crypto'
import { runWithContext } from './ctx-store.js'

/** host 装配管道时使用的驱动标识（QQ 网关半边）。 */
export const LEGACY_DRIVER_ID = 'onebot'

/** 本管道的协议来源（当前唯一驱动 SnowLuma 说 OneBot v11）。 */
const LEGACY_PROTOCOL = 'onebot:v11'

/**
 * 熔断开关解析：FLAG_USE_PIPELINE。
 * 仅 'true' / '1'（忽略大小写与首尾空白）算开启；'false'、乱值、未设置一律 false。
 * @param {Record<string, string | undefined>} [env] 注入的环境变量表，默认取进程环境
 * @returns {boolean}
 */
export function isPipelineEnabled(env = process.env) {
  const raw = env?.FLAG_USE_PIPELINE
  if (typeof raw !== 'string') return false
  const v = raw.trim().toLowerCase()
  return v === 'true' || v === '1'
}

/**
 * M4 总开关解析：FLAG_MODULAR_CORE（模块化新核心主链）。
 * 解析口径与 FLAG_USE_PIPELINE 同款：仅 'true'/'1'（忽略大小写与首尾空白）算开，
 * 'false'、乱值、未设置一律 false——默认关，legacy 直调路径逐字不变（任务书 M4-0 红线）。
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isModularCoreEnabled(env = process.env) {
  const raw = env?.FLAG_MODULAR_CORE
  if (typeof raw !== 'string') return false
  const v = raw.trim().toLowerCase()
  return v === 'true' || v === '1'
}

/**
 * 旧 OneBot v11 事件 → RFC §3.1 InboundEnvelope 适配层。
 * 信封字段尽量填全；事件里没有的字段置 undefined（见各行注释），
 * rawPayload 保留原事件引用不拷贝——旧入口要吃的就是这份原始报文。
 * @param {Record<string, any>} ev OneBot v11 原始事件
 * @returns {import('./types.js').InboundEnvelope}
 */
export function legacyEventToEnvelope(ev) {
  const event = ev && typeof ev === 'object' ? ev : {}
  // message_sent 是 v11 的「自己发出」事件，归并进 message 大类（细分看 rawPayload.post_type）
  const type = event.post_type === 'message_sent' ? 'message' : event.post_type
  const sender = event.sender
  // F4（2026-11-07 补评）：部分网关的私聊 message 事件不带 sender 对象，或 sender 里没有
  // user_id，身份只在事件顶层。hub 的解析口径本就是顶层优先（src/chat/inbound.js:35
  // `event.user_id ?? event.sender?.user_id`），host 的危险命令拦截也直接读 ev.user_id。
  // 信封缺这层兜底时，pipeline-on 会被 acl 以「缺少发送者身份」fail-closed 整条丢弃，
  // 而 legacy 同一份报文能正常回复——这是管道独有的行为差，故在此补齐。
  // 兜底只对 message 大类生效：notice/poke 等事件旧核心本就不按 sender 认人，
  // 凭空合成 sender 会改变终端与 acl 对通知类事件的既有形态判定。
  const senderUserIdFallback = type === 'message' && event.user_id != null ? String(event.user_id) : undefined
  const segments = Array.isArray(event.message)
    ? Object.freeze(event.message.map((seg) => {
        const s = seg && typeof seg === 'object' ? seg : {}
        return Object.freeze({ type: String(s.type ?? ''), data: Object.freeze({ ...(s.data || {}) }) })
      }))
    : Object.freeze([])
  const rawText = segments.filter((s) => s.type === 'text').map((s) => String(s.data.text ?? '')).join('')
  return Object.freeze({
    id: event.message_id != null ? String(event.message_id) : crypto.randomUUID(),
    protocol: LEGACY_PROTOCOL,
    type, // 'request' / 'meta' 等无旧入口处理的事件也原样入信封，由终端按 rawPayload 判定跳过
    subType: event.message_type ?? event.notice_type ?? event.request_type ?? event.meta_event_type ?? undefined,
    timestamp: typeof event.time === 'number' ? event.time * 1000 : Date.now(), // v11 time 为秒级；缺失用接收时刻兜底
    selfId: event.self_id != null ? String(event.self_id) : undefined, // 私聊 notice 等可能不带
    sender: sender && typeof sender === 'object'
      ? Object.freeze({
          userId: sender.user_id != null ? String(sender.user_id) : senderUserIdFallback, // F4：sender 缺 user_id → 顶层兜底
          nickname: sender.nickname ?? undefined,
          card: sender.card ?? undefined,
          role: sender.role ?? undefined,
        })
      : senderUserIdFallback === undefined
        ? undefined // poke 等通知类事件没有 sender 结构（不凭空合成，维持原形态判定）
        // 无 sender 结构的 message 事件：只补身份字段，其余仍 undefined（同形，不造昵称/角色）
        : Object.freeze({ userId: senderUserIdFallback, nickname: undefined, card: undefined, role: undefined }),
    messageId: event.message_id != null ? String(event.message_id) : undefined,
    segments,
    rawText,
    channelId: event.channel_id != null ? String(event.channel_id) : undefined, // v11 频道服务才有
    groupId: event.group_id != null ? String(event.group_id) : undefined,
    rawPayload: event,
  })
}

/**
 * 把遗留巨石 hub 包成洋葱终端中间件（RFC §4 Phase 0 的 createLegacyHubFallback）。
 *
 * US-007 出口切换补的一条硬约束：旧入口必须在 AsyncLocalStorage 里执行
 * （runWithContext(ctx, …)），这样旧核心深处 await/setTimeout 链里的每一次发送都能
 * `getCurrentContext()` 拿到本轮 ctx，把消息段投进 ctx.reply 缓冲池——不改 hub 一个签名。
 * ALS 穿透定时器是 Node 内置行为（run 期内创建的 async resource 一律继承 store），
 * 已由 test/kernel-egress-cutover.test.js 钉住。
 *
 * 路由与 host.js handleEvent 现行分发逐条对齐：
 *   - post_type 'message' / 'message_sent' → legacyHub.onMessage(原事件)
 *   - post_type 'notice' 且 notice_type 'notify' 且 sub_type 'poke' → legacyHub.onPoke(原事件)
 *   - 其余事件旧核心本就不处理，直接放行给 next()
 * @param {{ onMessage?: (event: object) => any, onPoke?: (event: object) => any }} legacyHub 旧 hub 实例（createHub 返回值）
 * @returns {import('./types.js').Middleware}
 */
export function createLegacyHubFallback(legacyHub) {
  return async function legacyHubFallback(ctx, next) {
    const event = ctx?.inbound?.rawPayload
    const postType = event && typeof event === 'object' ? event.post_type : undefined
    if (legacyHub && event) {
      if (postType === 'message' || postType === 'message_sent') {
        if (typeof legacyHub.onMessage === 'function') await runWithContext(ctx, () => legacyHub.onMessage(event))
      } else if (postType === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
        if (typeof legacyHub.onPoke === 'function') await runWithContext(ctx, () => legacyHub.onPoke(event))
      }
    }
    await next()
  }
}

/**
 * 剥掉 compose 的 PipelineError 包装，取回根因错误（找不到则原样返回）。
 * Phase 0 期间 host 的错误日志走它，保证开关打开后「处理消息出错：xxx」
 * 的文案与旧路径一致（管道会把每层错误再包一层，index 递增的 originalCause 链）。
 * @param {any} error
 * @returns {any}
 */
export function unwrapPipelineError(error) {
  let e = error
  while (e && e.name === 'PipelineError' && e.originalCause && e.originalCause !== e) {
    e = e.originalCause
  }
  return e
}
