// M5 审计 §2 · 模块发送桥：开旗态把模块侧「文本类」主动发送并入新核心 outbox 唯一出口。
//
// 背景：模块 api.sendText/reply/sendSegments 直连 legacy hub，绕开统一出站——
// 台账不记、dryRun 拦不住、身份泄露闸不过。开旗后必须收口。
// 媒体发送（图片/文件/语音转码）依赖 hub 的重管线（下载→上传→转码），本轮未并入，
// 原样透传 legacy 并如实登记（audit §2 挂账项）；纯文本段全部走 outbox。
//
// 返回形状兼容：hub.sendText 返回网关回执对象（{message_id}）或 null；
// 桥统一返回 { message_id, state }（state 取 outbox 三态；被拦时 message_id=null，与 legacy 关闸返回 null 的判truthy用法兼容）。

export function createModuleSendBridge({ hub, outbox, log }) {
  const debug = (m) => { try { log?.debug?.(m) } catch {} }

  async function sendViaOutbox(chatId, segments, sourceModuleId) {
    const r = await outbox.request({
      chatKey: String(chatId),
      sourceModuleId: sourceModuleId || 'module',
      segments,
    })
    return { message_id: r.gatewayMessageId ?? null, state: r.state }
  }

  function textOnlySegments(message) {
    const arr = Array.isArray(message) ? message : [{ type: 'text', data: { text: String(message ?? '') } }]
    return arr.every((s) => s && s.type === 'text') ? arr : null
  }

  const sendText = (chatId, text, sourceModuleId) => sendViaOutbox(chatId, [{ type: 'text', data: { text: String(text ?? '') } }], sourceModuleId)

  const sendSegments = (chatId, message, note, opts = {}) => {
    const texts = textOnlySegments(message)
    if (texts) return sendViaOutbox(chatId, texts, opts.sourceModuleId || note)
    debug(`模块媒体发送未并入唯一出站（§2 挂账，走 legacy 管线）：${String(chatId)} ${note || ''}`)
    return hub.sendSegments(chatId, message, note, opts)
  }

  const reply = (msg, text, sourceModuleId) => sendViaOutbox(String(msg?.chatId), [{ type: 'text', data: { text: String(text ?? '') } }], sourceModuleId || 'module')

  // Proxy：只换 sendText/sendSegments/reply 三个写出口；其余方法（会话、查询、状态）原样透出。
  return new Proxy(hub, {
    get(t, k) {
      if (k === 'sendText') return sendText
      if (k === 'sendSegments') return sendSegments
      if (k === 'reply') return reply
      return t[k]
    },
  })
}
