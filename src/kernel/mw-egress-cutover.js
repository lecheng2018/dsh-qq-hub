// 出口切换装配件（RFC-0001 §4 Phase 1 验收「消除 hub 直接发送调用」/ US-007）。
//
// 三件（+一件物理出口），全部只在 host.js 的 FLAG_USE_PIPELINE=true 分支注入；
// 关闭态一个都不装，旧路径逐字不动。
//   1) createEgressSendHook    —— 顶替 hub 的 hooks.send：扩展模块改写语义一字不变，
//      另外把「这条消息原本要发去哪、note/priority/delayMs」记成投递草稿挂在 ctx.state。
//   2) createEgressOnebot      —— 包住注入 hub 的 onebot，这就是唯一物理出口的收口点：
//      live   → 认领草稿 → ctx.reply.enqueue → 吞掉协议端调用（回成功形态）；
//               旧核心的 bump('sent')/日志/群配额因此全部照旧，但包不在这里发出去了。
//      shadow → 同样入队（给 Dispatcher 算 hash），协议端调用照旧真发，另记一条
//               「旧通道实发 hash」供边界 flush 后逐条比对。
//   3) createEgressFlushMiddleware —— 边界 flush：旧入口与 mw-egress 回溯完成后，
//      先把 ctx 标成已收口，再把 Dispatcher.drain(ctx) 包进 traceStage('dispatcher') 真发；
//      shadow 模式逐条比对 hash，只打计数告警、绝不阻断。
//   4) createEgressSender      —— 交给 Dispatcher 的 sender：ReplyPayload 反向映射回
//      OneBot 动作 + 参数，与旧通道逐字段等价（upload_* 保留长超时与 base64 回退）。
//
// 为什么 enqueue 落在 onebot 包装、而不是 hooks.send 那一行：
//   sendSegments 的顺序是 身份泄露闸 → hooks.send → captureStore(模拟) → 总开关 → 试运行 → 下发。
//   在 hooks.send 里入队，会把「模拟 / 总开关关 / 试运行」三道安全闸一起绕过去（试运行变真发，
//   直接踩穿本仓「默认试运行、一句都不真发」的安全默认）。onebot 包装天然在三道闸之后，
//   与旧路径「什么时候真的发包」逐条等价；而 chatId/note 这些只在 hooks.send 才有的信息，
//   用投递草稿递过来。两处合起来仍是「唯一注入点」，hub.js 零改动。

import { hashReplyPayload } from './dispatcher.js'
import { traceStage } from './mw-tracing.js'
import { getCurrentContext, isContextFlushed, markContextFlushed } from './ctx-store.js'

/** 会被收口的协议端动作 → targetType。查询类（get_msg……）、状态类（set_input_status）、动作类（send_poke）不在内。 */
const SEND_TARGET = {
  send_group_msg: 'group',
  send_private_msg: 'private',
  upload_group_file: 'group',
  upload_private_file: 'private',
}
const UPLOAD_ACTIONS = new Set(['upload_group_file', 'upload_private_file'])

/** ctx.state 上的投递账本（drafts = hooks.send 记的待发元信息，oldSends = shadow 模式下旧通道实发 hash）。 */
const LEDGER_KEY = Symbol.for('dsh-qq-hub.kernel.egress-ledger')

function ledger(ctx) {
  let l
  try {
    l = ctx?.state?.get?.(LEDGER_KEY)
  } catch (error) {
    l = undefined
  }
  if (!l) {
    l = { drafts: [], oldSends: [] }
    try {
      ctx?.state?.set?.(LEDGER_KEY, l)
    } catch (error) {}
  }
  return l
}

function safeLog(log, level, args) {
  try {
    log?.[level]?.(...args)
  } catch (error) {}
}

/** 'group:555' / 'private:10001' → { targetType, targetId }；形态不认返回 null（保守直发）。 */
export function targetFromChatId(chatId) {
  const s = String(chatId ?? '')
  const i = s.indexOf(':')
  if (i <= 0) return null
  const kind = s.slice(0, i)
  if (kind !== 'group' && kind !== 'private') return null
  return { targetType: kind, targetId: s.slice(i + 1) }
}

/** OneBot 消息段 → 内核 segments：type/data 原样、逐段全新对象（绝不把旧数组引用漏进内核，观察项 2）。 */
export function messageToSegments(message) {
  const list = Array.isArray(message) ? message : message == null ? [] : [{ type: 'text', data: { text: String(message) } }]
  return list.map((seg) => {
    const s = seg && typeof seg === 'object' ? seg : {}
    const data = s.data && typeof s.data === 'object' ? { ...s.data } : {}
    return { type: String(s.type ?? ''), data }
  })
}

/** 段里第一个 reply 段的 id → quoteMessageId（只是观测口径；reply 段本身原样保留，保证线上字节等价）。 */
function extractQuoteMessageId(segments) {
  const q = segments.find((s) => s?.type === 'reply' && s.data?.id !== undefined)
  return q ? String(q.data.id) : undefined
}

/**
 * 组装 ReplyPayload——字段齐全是硬要求（缺 segments 会让 Dispatcher.drain 抛 TypeError，US-005 移交项）。
 * @param {object} [options]
 */
export function buildReplyPayload({ targetType, targetId, segments, priority, delayMs, quoteMessageId } = {}) {
  const payload = {
    targetType: targetType === 'group' ? 'group' : 'private',
    targetId: String(targetId ?? ''),
    segments: Array.isArray(segments) ? segments : [],
    priority: priority === 'HIGH' || priority === 'LOW' ? priority : 'NORMAL',
    // 缺省/非法 delayMs 兜 0 = US-007/A4#4 三选一拍板的**接线契约**（cutover 路径 hub.js:925 轮内已自 pacing，此处再叠 typing 估时就是双限速）：勿改成 undefined——会直接打红 test/kernel-egress-cutover.test.js:166/:458 两条钉；裁决与留档见 docs/rfc0001-mapping.md:49/:164/:267（A4#4）+ reports/2026-11-07-gemini38-real-issues-复核裁决.md 缺陷3。
    delayMs: Number.isFinite(delayMs) ? delayMs : 0,
  }
  // 与 mw-egress 同纪律：undefined 键不带上，enqueue 会把它 spread 进冻结对象，字段对照会多出噪声
  const quote = quoteMessageId === undefined || quoteMessageId === null
    ? extractQuoteMessageId(payload.segments)
    : String(quoteMessageId)
  if (quote !== undefined) payload.quoteMessageId = quote
  return payload
}

/**
 * hooks.send 变体：先原样跑旧实现（扩展模块改写/拦下语义一字不动），再把改写结果记成投递草稿。
 * @param {object} [options]
 * @param {(message: any, info: object) => Promise<any>} [options.legacySend] 旧实现（host.js 里就是 mods.filter('send', …)）
 * @param {{ debug?: Function }} [options.log]
 * @returns {(message: any, info?: object) => Promise<any>} 与 hub 原契约同形态的 hooks.send
 */
export function createEgressSendHook(options = {}) {
  const legacySend = typeof options.legacySend === 'function' ? options.legacySend : null
  const log = options.log
  return async function egressSendHook(message, info = {}) {
    const next = legacySend ? await legacySend(message, info) : message
    if (next === null) return null // 扩展模块拦下：不发、不入队，与旧路径完全一致
    const finalMessage = Array.isArray(next) ? next : message
    const ctx = getCurrentContext()
    if (!ctx || isContextFlushed(ctx)) return next // 非事件上下文 / 边界已过：回落旧 sender 直发
    const target = targetFromChatId(info?.chatId)
    if (!target) {
      safeLog(log, 'debug', ['send-hook: chatId 形态不认，保守直发：', String(info?.chatId ?? '')])
      return next
    }
    ledger(ctx).drafts.push({
      message: finalMessage,
      targetType: target.targetType,
      targetId: target.targetId,
      note: typeof info?.note === 'string' ? info.note : undefined,
      priority: info?.priority,
      delayMs: info?.delayMs,
    })
    return next
  }
}

/** 认领与 params.message 同一引用的草稿（同一轮多条时按入队顺序取第一条未认领的）。 */
function claimDraft(ctx, message) {
  const drafts = ledger(ctx).drafts
  for (const d of drafts) {
    if (!d.claimed && d.message === message) {
      d.claimed = true
      return d
    }
  }
  return null
}

/**
 * 协议端调用 → ReplyPayload。draft 缺失时（sendFile 这类绕过 hooks.send 的旁路）也照样能建——
 * 这就是「旁路清零」：认得出是消息发送，就没有一条能绕过队列直达网关。
 */
function payloadFromCall(action, params, draft) {
  const targetType = draft?.targetType ?? SEND_TARGET[action]
  const targetId = draft?.targetId ?? String((SEND_TARGET[action] === 'group' ? params?.group_id : params?.user_id) ?? '')
  const segments = UPLOAD_ACTIONS.has(action)
    ? [{ type: 'file', data: { file: params?.file, name: params?.name } }] // 与 hub.js 的 capture 表示法同款
    : messageToSegments(params?.message)
  return buildReplyPayload({
    targetType,
    targetId,
    segments,
    priority: draft?.priority,
    delayMs: draft?.delayMs,
  })
}

/** 吞包后的「成功形态」：旧核心照旧 bump('sent')、记日志、走群配额，计数语义不变。 */
function deferredOk(action, params, seq) {
  const id = `hub-deferred-${seq}`
  if (UPLOAD_ACTIONS.has(action)) return { file_id: id, file_name: String(params?.name ?? '') }
  return { message_id: id }
}

/**
 * 包住注入 hub 的 onebot：唯一物理出口收口点。
 * @param {object} [options]
 * @param {{ call: Function }} options.onebot 真网关客户端（shadow 模式与回落路径都要用它）
 * @param {'live' | 'shadow'} [options.mode='live']
 * @param {{ debug?: Function }} [options.log]
 * @returns {object} 与注入对象同形状的包装（其余方法原型委托，不改语义）
 */
export function createEgressOnebot(options = {}) {
  const inner = options.onebot
  if (!inner || typeof inner.call !== 'function') throw new TypeError('createEgressOnebot 需要注入 onebot 客户端')
  // review C2#1：wrapper 与 Dispatcher 的模式必须同源——非法值显式抛错，不再静默回 live。
  // host 装配只从同一个 egressMode 变量取值传给两处（见 host.js），本校验兜住装配错误。
  if (options.mode !== undefined && options.mode !== 'live' && options.mode !== 'shadow') {
    throw new TypeError(`createEgressOnebot mode 必须是 'live' 或 'shadow'，收到：${String(options.mode)}`)
  }
  const mode = options.mode === 'shadow' ? 'shadow' : 'live'
  const log = options.log
  let seq = 0
  const wrapped = Object.create(inner) // stop/restart/state 等方法原样可用，只有 call 被收口
  wrapped.call = async function call(action, params = {}, opts) {
    if (!SEND_TARGET[action]) return inner.call(action, params, opts) // 查询/状态/动作类：与旧路径一模一样
    const ctx = getCurrentContext()
    if (!ctx || isContextFlushed(ctx)) return inner.call(action, params, opts) // 非事件上下文：保守放行，仍是唯一注入点
    const draft = claimDraft(ctx, params?.message)
    const payload = payloadFromCall(action, params, draft)
    ctx.reply.enqueue(payload)
    if (mode === 'shadow') {
      // 账本先记 pending，发送结果回填状态（review C2#7：失败请求不得显示匹配）
      const rec = { hash: hashReplyPayload(payload), note: draft?.note, status: 'pending' }
      ledger(ctx).oldSends.push(rec)
      try {
        const r = await inner.call(action, params, opts) // 双算：旧通道真发
        rec.status = 'succeeded'
        return r
      } catch (error) {
        rec.status = 'failed'
        throw error
      }
    }
    safeLog(log, 'debug', ['egress: 收口待发 →', payload.targetType, payload.targetId, `segments=${payload.segments.length}`, draft?.note ? `note=${draft.note}` : ''])
    return deferredOk(action, params, ++seq)
  }
  return wrapped
}

/** ReplyPayload → OneBot 动作 + 参数（与 hub.js sendSegments/sendFile 的构造逐字段对齐）。 */
export function replyPayloadToCall(payload) {
  const group = payload?.targetType === 'group'
  const idKey = group ? 'group_id' : 'user_id'
  const segments = Array.isArray(payload?.segments) ? payload.segments : []
  const params = { [idKey]: Number(payload?.targetId), message: segments.map((s) => ({ type: s?.type, data: { ...s?.data } })) }
  if (segments.length === 1 && segments[0]?.type === 'file') {
    // 单条 file 段就是 hub 的 upload_*_file 表示法（本仓出站消息里没有 file 段，见 hub.js capture 分支）
    return {
      action: group ? 'upload_group_file' : 'upload_private_file',
      params: { [idKey]: Number(payload.targetId), file: segments[0].data?.file, name: segments[0].data?.name },
      opts: { timeoutMs: FILE_TIMEOUT_MS },
    }
  }
  return { action: group ? 'send_group_msg' : 'send_private_msg', params, opts: undefined }
}

/** 与 hub.js 同款：文件上传留长超时，别把大文件误判成失败。 */
export const FILE_TIMEOUT_MS = 120_000

/**
 * 「网关确认读不到本地文件」白名单判定（review C2#5）。只认结构化信号：
 *  - message/cause 文本含 no such file / ENOENT / file not found / 文件不存在 / 找不到路径；
 *  - 或网关回包 retcode 属已知的路径不可读码（当前无稳定码表，留空集，命中靠文本）。
 * 超时（AbortError、timeout）、连接重置（ECONNRESET）、鉴权（401/403/token）明确排除。
 */
const PATH_READ_PATTERNS = /no such file|enoent|file not found|文件不存在|找不到|路径不存在/i
const PATH_READ_RETCODES = new Set([])
export function isConfirmedPathReadError(error) {
  const text = `${error?.message ?? ''} ${error?.cause?.message ?? ''} ${error?.cause?.code ?? ''}`
  if (/abort|timeout|econnreset|econnrefused|401|403|token/i.test(text)) return false
  if (PATH_READ_RETCODES.has(error?.retcode)) return true
  return PATH_READ_PATTERNS.test(text)
}

/**
 * 创建交给 Dispatcher 的物理出口 sender。
 * @param {object} [options]
 * @param {(action: string, params: object, opts?: object) => Promise<any>} options.call 真网关调用（live 模式必填）
 * @param {(file: string) => Promise<string> | string} [options.uploadFile] 本机路径 → 'base64://…'（网关看不到路径时回退用，host 侧注入）
 * @param {{ debug?: Function, warn?: Function }} [options.log]
 * @returns {(payload: any) => Promise<any>}
 */
export function createEgressSender(options = {}) {
  const call = options.call
  if (typeof call !== 'function') throw new TypeError('createEgressSender 需要注入 call(action, params, opts)')
  const uploadFile = typeof options.uploadFile === 'function' ? options.uploadFile : null
  const log = options.log
  return async function egressSender(payload) {
    const { action, params, opts } = replyPayloadToCall(payload)
    try {
      return await call(action, params, opts)
    } catch (error) {
      // review C2#5：旧实现「任何异常都转 base64 重传」——首次已成功但回包超时时会双份上传，
      // 鉴权/限流错误也会触发无意义二次上传。现仅对**可确认的远端路径读取失败**回退，
      // 超时（AbortError/timeout）、连接重置、鉴权类一律上抛，由 Dispatcher 计 failed。
      const external = /^(https?:\/\/|base64:\/\/)/i.test(String(params?.file ?? ''))
      if (!uploadFile || !UPLOAD_ACTIONS.has(action) || external || !isConfirmedPathReadError(error)) throw error
      const b64 = await uploadFile(String(params.file))
      safeLog(log, 'debug', ['egress: 网关确认读不到本机路径，改走 base64 重发：', String(params.file)])
      return call(action, { ...params, file: b64 }, opts)
    }
  }
}

/**
 * 边界 flush 中间件：必须装在 mw-egress 的**外层**（compose 数组里排在它前面），
 * 这样回溯顺序才是「旧入口 → egress 清洗 → drain 下发」。
 * @param {object} [options]
 * @param {{ drain: Function, mode: string, shadowRecords?: Function }} options.dispatcher US-005 的 createDispatcher 返回值
 * @param {{ debug?: Function, warn?: Function }} [options.log] shadow 比对计数日志出口（建议 logger.child('egress-shadow')）
 * @param {string} [options.stageName='dispatcher'] 喂给 traceStage 的段名
 * @returns {Function} Middleware
 */
export function createEgressFlushMiddleware(options = {}) {
  const dispatcher = options.dispatcher
  if (!dispatcher || typeof dispatcher.drain !== 'function') {
    throw new TypeError('createEgressFlushMiddleware 需要注入 dispatcher（createDispatcher 的返回值）')
  }
  const log = options.log
  const stageName = typeof options.stageName === 'string' ? options.stageName : 'dispatcher'
  const shadow = dispatcher.mode === 'shadow'

  return async function egressFlushMiddleware(ctx, next) {
    try {
      await next() // 内层依次是 mw-egress（清洗+分条+沉默丢弃）与 legacy 终端（旧入口）
    } catch (error) {
      // review C2#3：内层抛错时已 enqueue 的「假成功」消息绝不能留在死队列里——
      // 立边界 + 清空队列（计数告警，这些条目视为被本轮异常带走），再原样上抛。
      // 不把 drain 塞进 finally：清洗中途失败的内容不该外发（宁丢半轮不发脏话）。
      markContextFlushed(ctx)
      const stranded = Array.isArray(ctx?.reply?.queue) ? ctx.reply.queue.length : 0
      if (stranded > 0) {
        try { ctx.reply.clear() } catch { /* 队列容器坏也不掩主错 */ }
        safeLog(log, 'warn', [`egress: 内层抛错，丢弃未下发条目 ${stranded} 条（异常轮不 flush）：${error?.message ?? error}`])
      }
      throw error
    }
    // 先立边界：之后同一条异步链上晚到的发送一律回落旧通道，绝不落进即将排空的队列
    markContextFlushed(ctx)
    const ids = shadow ? new Set((Array.isArray(ctx?.reply?.queue) ? [...ctx.reply.queue] : []).map((p) => p?.id)) : null
    const summary = await traceStage(ctx, stageName, async () => dispatcher.drain(ctx))
    if (shadow) compareShadow(ctx, ids, summary)
    return summary
  }

  function compareShadow(ctx, ids, summary) {
    const allOld = ledger(ctx).oldSends
    // review C2#7：失败/未完成的旧通道记录不参与 match 判定，单独计数告警
    const oldSends = allOld.filter((r) => r.status === 'succeeded')
    const oldFailed = allOld.length - oldSends.length
    const mine = typeof dispatcher.shadowRecords === 'function'
      ? dispatcher.shadowRecords().filter((r) => ids?.has(r.id))
      : []
    let match = 0
    let mismatch = 0
    const detail = []
    const n = Math.max(oldSends.length, mine.length)
    for (let i = 0; i < n; i += 1) {
      const a = oldSends[i]?.hash
      const b = mine[i]?.hash
      if (a && b && a === b) {
        match += 1
        continue
      }
      mismatch += 1
      if (detail.length < 5) detail.push(`#${i + 1} old=${a ?? '-'} new=${b ?? '-'}`)
    }
    const traceId = String(ctx?.meta?.traceId ?? '-').slice(0, 8)
    // F8（2026-11-07 补评）：零样本时「match=0 mismatch=0」不叫干净，叫没数据——现行装配下
    // 主气泡走包装器直发分支（F1），shadow 账本常年为空，e2e SHADOW 态全绿不能读成治理生效。
    // 明写「无队列支路样本」并升 info，别让空账本伪装成比对通过。有样本时维持原 debug 逐条计数。
    if (match === 0 && mismatch === 0 && oldFailed === 0) {
      safeLog(log, 'info', [`[egress-shadow] 无队列支路样本（气泡直发不在治理面）——非「比对通过」，勿据此判治理生效（补评 F1/F8）total=${summary?.total ?? 0} trace=${traceId}`])
      return
    }
    safeLog(log, 'debug', [`[egress-shadow] match=${match} mismatch=${mismatch} oldFailed=${oldFailed} old=${oldSends.length} new=${mine.length} total=${summary?.total ?? 0} trace=${traceId}`, detail.join(' ')])
    // 比对不一致是预期内的（清洗/分条本来就会改内容）：只计数告警，不阻断、不改发包
    if (mismatch > 0) safeLog(log, 'warn', [`[egress-shadow] 新旧通道内容有 ${mismatch} 条不一致（切权前先看清）trace=${traceId}`])
  }
}
