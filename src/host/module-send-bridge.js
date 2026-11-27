// 模块发送桥：文本/图片直入共享 Outbox；需要下载、转码或上传的媒体复用 hub 语义适配。
// unified=true 时 hub 已接同一 Outbox，不再用 recordExternal 重复补账。
// captureOnly 保证面板模拟测试只记录、不实发。
//
// 出站清洗（真机 2026-11-15）：主回复链路的清洗在 reply-delivery（deliver 路径），
// 模块的 sendText/sendSegments/reply 直发走这里——模型思考残片会从这条口子漏出去。
// 在适配层统一过 sanitizeOutbound（含代码块保护；幂等），outbox 本身保持「segments
// 原样透传」的既有契约（清洗是适配层的事，见 m2d-outbox-ledger 测试）。
//
// 非 core 模块主动推送治理层：
//   - per-(sourceModuleId, chatKey) 最小发送间隔（pacingMs，默认非测试环境 1500ms，支持注入/配置）；
//   - 短窗口突发上限（默认 60s 内同模块同会话最多 4 条，超限记日志并暂存合并延迟/限流）；
//   - pushDigest 静默时段、聊天静音与道别静默保护（非紧急主动推送暂存汇总，核心/审批/命令/显式回复零影响）。

import { sanitizeOutbound } from '../chat/reply.js'

const EXEMPT_MODULES = new Set(['core', 'hub', 'qq-tools', 'approval', 'approvals', 'questions', 'danger-guard', 'command'])
const DEFAULT_PACING_MS = 1500
const DEFAULT_BURST_WINDOW_MS = 60_000
const DEFAULT_BURST_LIMIT = 4
const DEFAULT_MAX_DIGEST_ITEMS = 20
const MAX_DIGEST_CHARS = 1800

function inQuietHours(hour, range) {
  if (!Array.isArray(range) || range.length !== 2) return false
  const [start, end] = [Number(range[0]), Number(range[1])]
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end)
}

function plainTextOfSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return ''
  if (!segments.every((s) => s?.type === 'text' && typeof s.data?.text === 'string')) return ''
  return segments.map((s) => s.data.text).join('').trim()
}

export function createModuleSendBridge({
  hub, outbox, log, unified = false,
  getConfig, isMuted, isProactivelyMuted,
  now = () => Date.now(), sleep, pushPolicy,
} = {}) {
  const debug = (m) => { try { log?.debug?.(m) } catch {} }
  const warn = (m) => { try { log?.warn?.(m) } catch {} }
  const info = (m) => { try { log?.info?.(m) } catch {} }
  const wait = typeof sleep === 'function'
    ? sleep
    : (ms) => new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      t.unref?.()
    })

  /** key (`modId|chatKey`) -> Promise（同模块同会话串行节流链） */
  const pacingChains = new Map()
  /** key -> 最近一次发送时间戳 */
  const lastSentAt = new Map()
  /** key -> number[]（短窗口内已发时间戳） */
  const windowStamps = new Map()
  /** key -> { chatKey, sourceModuleId, items: Array<{ text: string, createdAt: number }>, timer } */
  const digestBuffers = new Map()
  let disposed = false

  const isTestEnv = process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
    || process.execArgv.some((a) => a === '--test' || a.startsWith('--test-'))

  function resolvePolicy() {
    let cfg = null
    try { cfg = typeof getConfig === 'function' ? getConfig() : null } catch {}
    const cfgGuard = cfg?.pushGuard || {}
    const cfgDigest = cfg?.pushDigest || {}
    const over = pushPolicy || {}
    const hasExplicitPolicy = Boolean(pushPolicy || cfg?.pushGuard || cfg?.pushDigest)
    const enabled = (over.enabled ?? cfgGuard.enabled ?? (isTestEnv && !hasExplicitPolicy ? false : true)) !== false
    const rawPacing = over.pacingMs ?? cfgGuard.pacingMs
    const pacingMs = rawPacing !== undefined
      ? Math.max(0, Number(rawPacing) || 0)
      : (isTestEnv ? 0 : DEFAULT_PACING_MS)
    const burstWindowMs = Math.max(100, Number(over.burstWindowMs ?? cfgGuard.burstWindowMs) || DEFAULT_BURST_WINDOW_MS)
    const burstLimit = Math.max(1, Math.floor(Number(over.burstLimit ?? cfgGuard.burstLimit) || DEFAULT_BURST_LIMIT))
    const maxDigestItems = Math.max(1, Math.floor(Number(over.maxDigestItems ?? cfgDigest.maxItems ?? cfgGuard.maxDigestItems) || DEFAULT_MAX_DIGEST_ITEMS))
    const rawQuiet = over.quietHours ?? cfgDigest.quietHours ?? cfgGuard.quietHours
    const quietHours = Array.isArray(rawQuiet) && rawQuiet.length === 2 ? rawQuiet : null
    const digestEnabled = (over.digestEnabled ?? cfgDigest.enabled ?? cfgGuard.digestEnabled ?? true) !== false
    return { enabled, pacingMs, burstWindowMs, burstLimit, maxDigestItems, quietHours, digestEnabled }
  }

  /** 文本段出站清洗：只碰 text 段；cleaned 全空时整段丢弃（一条全是思考残片的消息没有发送价值）。 */
  function cleanSegments(segments) {
    let changed = false
    const out = []
    for (const seg of segments) {
      if (seg?.type === 'text' && typeof seg.data?.text === 'string' && seg.data.text) {
        const next = sanitizeOutbound(seg.data.text)
        if (next !== seg.data.text) changed = true
        if (!next.trim()) { changed = true; continue } // 整段都是思考残片 → 丢弃
        out.push(changed ? { type: 'text', data: { text: next } } : seg)
      } else out.push(seg)
    }
    return changed ? out : segments
  }

  function isExempt(sourceModuleId, opts = {}) {
    return EXEMPT_MODULES.has(sourceModuleId)
      || opts.urgent === true
      || opts.isReply === true
      || opts.bypassPushGuard === true
  }

  function quietReasonFor(chatKey, policy) {
    const busy = (() => { try { return hub.isBusy?.(chatKey) === true } catch { return false } })()
    if (busy) return ''
    try { if (isMuted?.(chatKey) === true) return 'muted' } catch {}
    try { if (isProactivelyMuted?.(chatKey, now()) === true) return 'proactive-muted' } catch {}
    if (policy.quietHours) {
      const hour = new Date(now()).getHours()
      if (inQuietHours(hour, policy.quietHours)) return 'quiet-hours'
    }
    return ''
  }

  function enqueueKey(key, fn) {
    const prev = pacingChains.get(key) || Promise.resolve()
    const run = prev.catch(() => {}).then(fn)
    const tail = run.catch(() => {})
    pacingChains.set(key, tail)
    tail.finally(() => {
      if (pacingChains.get(key) === tail) pacingChains.delete(key)
    })
    return run
  }

  function pruneStamps(key, currentNow, burstWindowMs) {
    const list = windowStamps.get(key)
    if (!list) return []
    const cutoff = currentNow - burstWindowMs
    const kept = list.filter((ts) => ts > cutoff)
    if (kept.length) windowStamps.set(key, kept)
    else windowStamps.delete(key)
    return kept
  }

  function recordSendStamp(key, currentNow, burstWindowMs) {
    const kept = pruneStamps(key, currentNow, burstWindowMs)
    kept.push(currentNow)
    windowStamps.set(key, kept)
    lastSentAt.set(key, currentNow)
  }

  function stashDigest(chatKey, sourceModuleId, text, policy, { delayMs = 0 } = {}) {
    const key = `${sourceModuleId}|${chatKey}`
    let buf = digestBuffers.get(key)
    if (!buf) {
      buf = { chatKey, sourceModuleId, items: [], timer: null }
      digestBuffers.set(key, buf)
    }
    if (buf.items.length >= policy.maxDigestItems) {
      buf.items.shift()
    }
    buf.items.push({ text, createdAt: now() })
    if (delayMs > 0 && !buf.timer && !disposed) {
      buf.timer = setTimeout(() => {
        buf.timer = null
        flushDigest({ chatKey, sourceModuleId }).catch((err) => debug(`推送汇总补发失败（${key}）：${err?.message || err}`))
      }, Math.max(10, delayMs))
      buf.timer.unref?.()
    }
    return buf.items.length
  }

  async function flushDigest({ chatKey, sourceModuleId, force = false } = {}) {
    if (disposed) return []
    const policy = resolvePolicy()
    const results = []
    for (const [key, buf] of [...digestBuffers.entries()]) {
      if (chatKey && buf.chatKey !== String(chatKey)) continue
      if (sourceModuleId && buf.sourceModuleId !== String(sourceModuleId)) continue
      if (!buf.items.length) {
        if (buf.timer) { clearTimeout(buf.timer); buf.timer = null }
        digestBuffers.delete(key)
        continue
      }
      if (!force) {
        const qReason = quietReasonFor(buf.chatKey, policy)
        if (qReason) continue
      }
      if (buf.timer) { clearTimeout(buf.timer); buf.timer = null }
      const items = buf.items.splice(0)
      digestBuffers.delete(key)
      let merged = items.length === 1
        ? items[0].text
        : `【${buf.sourceModuleId} 汇总 ${items.length} 条】\n${items.map((it) => it.text).join('\n---\n')}`
      if (merged.length > MAX_DIGEST_CHARS) merged = `${merged.slice(0, MAX_DIGEST_CHARS - 1)}…`
      const r = await outbox.request({
        chatKey: buf.chatKey,
        sourceModuleId: buf.sourceModuleId,
        segments: [{ type: 'text', data: { text: merged } }],
      })
      recordSendStamp(key, now(), policy.burstWindowMs)
      info(`模块「${buf.sourceModuleId}」汇总推送已补发 → ${buf.chatKey}（合并 ${items.length} 条）`)
      results.push({ chatKey: buf.chatKey, sourceModuleId: buf.sourceModuleId, count: items.length, state: r.state, message_id: r.gatewayMessageId ?? null })
    }
    return results
  }

  async function runGoverned({ chatKey, sourceModuleId, segments, opts = {}, execute }) {
    const policy = resolvePolicy()
    if (!policy.enabled || isExempt(sourceModuleId, opts)) {
      return execute()
    }
    const text = plainTextOfSegments(segments)
    const qReason = quietReasonFor(chatKey, policy)
    if (qReason) {
      if (policy.digestEnabled && text) {
        const count = stashDigest(chatKey, sourceModuleId, text, policy)
        debug(`模块「${sourceModuleId}」向 ${chatKey} 的主动推送因 ${qReason} 暂存待汇总（已攒 ${count} 条）`)
        return { message_id: null, state: 'digested', reason: qReason, deferred: true }
      }
      debug(`模块「${sourceModuleId}」向 ${chatKey} 的主动推送因 ${qReason} 已拦截`)
      return { message_id: null, state: 'throttled', reason: qReason }
    }

    const key = `${sourceModuleId}|${chatKey}`
    return enqueueKey(key, async () => {
      if (disposed) return { message_id: null, state: 'cancelled' }
      const currentNow = now()
      const stamps = pruneStamps(key, currentNow, policy.burstWindowMs)
      if (stamps.length >= policy.burstLimit) {
        warn(`模块「${sourceModuleId}」向 ${chatKey} 触发防刷屏突发上限（${Math.round(policy.burstWindowMs / 1000)}s 内已发 ${stamps.length}/${policy.burstLimit} 条）`)
        if (policy.digestEnabled && text) {
          const delayMs = Math.max(policy.pacingMs, (stamps[0] + policy.burstWindowMs) - currentNow)
          const count = stashDigest(chatKey, sourceModuleId, text, policy, { delayMs })
          debug(`模块「${sourceModuleId}」超限消息已并入延迟汇总（${chatKey}，已攒 ${count} 条）`)
          return { message_id: null, state: 'digested', reason: 'burst-limit', deferred: true }
        }
        return { message_id: null, state: 'throttled', reason: 'burst-limit' }
      }
      const prevAt = lastSentAt.get(key) || 0
      const gap = prevAt > 0 && policy.pacingMs > 0 ? (prevAt + policy.pacingMs) - currentNow : 0
      if (gap > 0) await wait(gap)
      if (disposed) return { message_id: null, state: 'cancelled' }
      recordSendStamp(key, now(), policy.burstWindowMs)
      return execute()
    })
  }

  async function sendViaOutbox(chatId, segments, sourceModuleId, opts = {}) {
    const cleaned = cleanSegments(segments)
    if (!cleaned.length) { debug(`${chatId}：清洗后没有剩余内容，不发送`); return { message_id: null, state: 'cancelled' } }
    const chatKey = String(chatId)
    const modId = String(sourceModuleId || 'module')
    const captured = hub.captureOnly?.(chatKey, cleaned, modId)
    if (captured) return { ...captured, state: 'sent' }
    return runGoverned({
      chatKey,
      sourceModuleId: modId,
      segments: cleaned,
      opts,
      execute: async () => {
        const r = await outbox.request({
          chatKey,
          sourceModuleId: modId,
          segments: cleaned,
        })
        return { message_id: r.gatewayMessageId ?? null, state: r.state }
      },
    })
  }

  /** outbox 能直发的段：文本 + 图片（OneBot 的 send_*_msg 原生接受 image 段，file 可为 url/base64://）。 */
  function textOnlySegments(message) {
    const arr = Array.isArray(message) ? message : [{ type: 'text', data: { text: String(message ?? '') } }]
    const ok = arr.every((s) => s && (s.type === 'text' || (s.type === 'image' && s.data && (s.data.file || s.data.url || s.data.path))))
    return ok ? arr : null
  }

  const sendText = (chatId, text, sourceModuleId, opts = {}) => {
    const modId = typeof sourceModuleId === 'string' ? sourceModuleId : (sourceModuleId?.sourceModuleId || opts?.sourceModuleId)
    const options = typeof sourceModuleId === 'object' && sourceModuleId ? sourceModuleId : opts
    return sendViaOutbox(chatId, [{ type: 'text', data: { text: String(text ?? '') } }], modId, options)
  }

  const sendSegments = (chatId, message, note, opts = {}) => {
    const modId = opts?.sourceModuleId || (typeof note === 'string' ? note : '') || 'module'
    const texts = textOnlySegments(message)
    if (texts) return sendViaOutbox(chatId, texts, modId, opts)
    const chatKey = String(chatId)
    debug(`模块媒体复用 hub 上载/转码管线：${chatKey} ${note || ''}`)
    return runGoverned({
      chatKey,
      sourceModuleId: modId,
      segments: Array.isArray(message) ? message : [],
      opts,
      execute: () => Promise.resolve(hub.sendSegments(chatId, message, note, { ...opts, sourceModuleId: modId })).then((r) => {
        try {
          if (!unified) outbox.recordExternal?.({
            chatKey,
            sourceModuleId: modId,
            segments: Array.isArray(message) ? message : [],
            gatewayMessageId: r?.message_id ?? r?.messageId ?? null,
          })
        } catch { /* 记账失败不影响已发出的消息 */ }
        return r
      }),
    })
  }

  const reply = (msg, text, sourceModuleId) => sendViaOutbox(String(msg?.chatId), [
    ...(msg?.kind === 'group' && msg?.messageId ? [{ type: 'reply', data: { id: String(msg.messageId) } }] : []),
    { type: 'text', data: { text: String(text ?? '') } },
  ], sourceModuleId || 'module', { isReply: true })

  /** 媒体复用 hub；仅兼容未接 Outbox 的调用方时才补外部台账。支持调用方透传 opts.sourceModuleId。 */
  const wrapOutbound = (name, defaultSourceModuleId, optsIndex) => async (...args) => {
    const chatId = String(args[0] ?? '')
    const rawOpts = optsIndex !== undefined ? args[optsIndex] : undefined
    const opts = rawOpts && typeof rawOpts === 'object' ? rawOpts : {}
    const sourceModuleId = String(opts.sourceModuleId || defaultSourceModuleId)
    const forwardedArgs = args.slice()
    if (optsIndex !== undefined) {
      forwardedArgs[optsIndex] = { ...opts, sourceModuleId }
    }
    return runGoverned({
      chatKey: chatId,
      sourceModuleId,
      segments: [],
      opts,
      execute: async () => {
        const r = await hub[name](...forwardedArgs)
        try {
          if (!unified) outbox.recordExternal?.({
            chatKey: chatId,
            sourceModuleId,
            segments: [],
            gatewayMessageId: r?.message_id ?? r?.messageId ?? null,
            reason: `${name} 走当前媒体管线`,
          })
        } catch { /* 记账失败不影响已发出的消息 */ }
        return r
      },
    })
  }

  const outboundWraps = {
    sendImage: (chatId, src, replyId, userId, opts) => wrapOutbound('sendImage', 'imagegen', 4)(chatId, src, replyId, userId, { allowLocal: true, ...opts }),
    sendSticker: wrapOutbound('sendSticker', 'stickers', 4),
    sendFile: wrapOutbound('sendFile', 'qq-tools', 3),
    sendVoice: wrapOutbound('sendVoice', 'voice', 4),
    sendVoiceFile: wrapOutbound('sendVoiceFile', 'voice', 3),
  }

  function pendingDigests() {
    return [...digestBuffers.values()].map((b) => ({
      chatKey: b.chatKey,
      sourceModuleId: b.sourceModuleId,
      count: b.items.length,
      items: b.items.map((it) => ({ ...it })),
    }))
  }

  function dispose() {
    disposed = true
    for (const buf of digestBuffers.values()) {
      if (buf.timer) { clearTimeout(buf.timer); buf.timer = null }
    }
    digestBuffers.clear()
    pacingChains.clear()
    lastSentAt.clear()
    windowStamps.clear()
  }

  const descriptors = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(hub)).map(([key, descriptor]) => [key, 'value' in descriptor ? { ...descriptor, writable: true, configurable: true } : { ...descriptor, configurable: true }]))
  const facade = Object.defineProperties({}, descriptors)
  Object.assign(facade, { sendText, sendSegments, reply, ...outboundWraps, flushDigest, pendingDigests, dispose })
  return Object.freeze(facade)
}
