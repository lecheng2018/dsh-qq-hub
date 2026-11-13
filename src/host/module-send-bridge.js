// 模块发送桥：文本/图片直入共享 Outbox；需要下载、转码或上传的媒体复用 hub 语义适配。
// unified=true 时 hub 已接同一 Outbox，不再用 recordExternal 重复补账。
// captureOnly 保证面板模拟测试只记录、不实发。
//
// 返回形状兼容：hub.sendText 返回网关回执对象（{message_id}）或 null；
// 桥统一返回 { message_id, state }（state 取 outbox 三态；被拦时 message_id=null，与 legacy 关闸返回 null 的判truthy用法兼容）。

export function createModuleSendBridge({ hub, outbox, log, unified = false }) {
  const debug = (m) => { try { log?.debug?.(m) } catch {} }

  async function sendViaOutbox(chatId, segments, sourceModuleId) {
    const captured = hub.captureOnly?.(String(chatId), segments, sourceModuleId || 'module')
    if (captured) return { ...captured, state: 'sent' }
    const r = await outbox.request({
      chatKey: String(chatId),
      sourceModuleId: sourceModuleId || 'module',
      segments,
    })
    return { message_id: r.gatewayMessageId ?? null, state: r.state }
  }

  /** outbox 能直发的段：文本 + 图片（OneBot 的 send_*_msg 原生接受 image 段，file 可为 url/base64://）。 */
  function textOnlySegments(message) {
    const arr = Array.isArray(message) ? message : [{ type: 'text', data: { text: String(message ?? '') } }]
    const ok = arr.every((s) => s && (s.type === 'text' || (s.type === 'image' && s.data && (s.data.file || s.data.url || s.data.path))))
    return ok ? arr : null
  }

  const sendText = (chatId, text, sourceModuleId) => sendViaOutbox(chatId, [{ type: 'text', data: { text: String(text ?? '') } }], sourceModuleId)

  const sendSegments = (chatId, message, note, opts = {}) => {
    const texts = textOnlySegments(message)
    if (texts) return sendViaOutbox(chatId, texts, opts.sourceModuleId || note)
    debug(`模块媒体复用 hub 上载/转码管线：${String(chatId)} ${note || ''}`)
    return Promise.resolve(hub.sendSegments(chatId, message, note, opts)).then((r) => {
      try {
        if (!unified) outbox.recordExternal?.({
          chatKey: String(chatId),
          sourceModuleId: opts.sourceModuleId || String(note || 'module'),
          segments: Array.isArray(message) ? message : [],
          gatewayMessageId: r?.message_id ?? r?.messageId ?? null,
        })
      } catch { /* 记账失败不影响已发出的消息 */ }
      return r
    })
  }

  const reply = (msg, text, sourceModuleId) => sendViaOutbox(String(msg?.chatId), [
    ...(msg?.kind === 'group' && msg?.messageId ? [{ type: 'reply', data: { id: String(msg.messageId) } }] : []),
    { type: 'text', data: { text: String(text ?? '') } },
  ], sourceModuleId || 'module')

  /** 媒体复用 hub；仅兼容未接 Outbox 的调用方时才补外部台账。 */
  const wrapOutbound = (name, sourceModuleId) => async (...args) => {
    const chatId = String(args[0] ?? '')
    const r = await hub[name](...args)
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
  }

  const outboundWraps = {
    sendImage: wrapOutbound('sendImage', 'imagegen'),
    sendSticker: wrapOutbound('sendSticker', 'stickers'),
    sendFile: wrapOutbound('sendFile', 'qq-tools'),
    sendVoice: wrapOutbound('sendVoice', 'voice'),
  }
  const descriptors = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(hub)).map(([key, descriptor]) => [key, 'value' in descriptor ? { ...descriptor, writable: true, configurable: true } : { ...descriptor, configurable: true }]))
  const facade = Object.defineProperties({}, descriptors)
  Object.assign(facade, { sendText, sendSegments, reply, ...outboundWraps })
  return Object.freeze(facade)
}
