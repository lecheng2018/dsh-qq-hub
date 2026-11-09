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
    // 语音(record)/文件/表情路径依赖 legacy 的上载与 TTS 管线，仍需 legacy 发；
    // 但发成功后补一条台账（B 方案收口：dryRun/泄漏闸在 legacy 侧已生效，台账这里补齐）
    debug(`模块媒体发送走 legacy 上载管线（语音/文件），补台账记一笔：${String(chatId)} ${note || ''}`)
    return Promise.resolve(hub.sendSegments(chatId, message, note, opts)).then((r) => {
      try {
        outbox.recordExternal?.({
          chatKey: String(chatId),
          sourceModuleId: opts.sourceModuleId || String(note || 'module'),
          segments: Array.isArray(message) ? message : [],
          gatewayMessageId: r?.message_id ?? r?.messageId ?? null,
        })
      } catch { /* 记账失败不影响已发出的消息 */ }
      return r
    })
  }

  const reply = (msg, text, sourceModuleId) => sendViaOutbox(String(msg?.chatId), [{ type: 'text', data: { text: String(text ?? '') } }], sourceModuleId || 'module')

  /** 其余 legacy 专属发送（表情库取图、文件上载、语音合成）：发完补台账。 */
  const wrapLegacy = (name, sourceModuleId) => async (...args) => {
    const chatId = String(args[0] ?? '')
    const r = await hub[name](...args)
    try {
      outbox.recordExternal?.({
        chatKey: chatId,
        sourceModuleId,
        segments: [],
        gatewayMessageId: r?.message_id ?? r?.messageId ?? null,
        reason: `${name} 走 legacy 上载管线`,
      })
    } catch { /* 记账失败不影响已发出的消息 */ }
    return r
  }

  // Proxy：写出口一律收口（文本/图片走 outbox；表情/文件/语音走 legacy 但补台账）
  const legacyWraps = {
    sendImage: wrapLegacy('sendImage', 'imagegen'),
    sendSticker: wrapLegacy('sendSticker', 'stickers'),
    sendFile: wrapLegacy('sendFile', 'qq-tools'),
    sendVoice: wrapLegacy('sendVoice', 'voice'),
    sendVoiceFile: wrapLegacy('sendVoiceFile', 'song'),
  }
  return new Proxy(hub, {
    get(t, k) {
      if (k === 'sendText') return sendText
      if (k === 'sendSegments') return sendSegments
      if (k === 'reply') return reply
      if (Object.prototype.hasOwnProperty.call(legacyWraps, k)) return legacyWraps[k]
      return t[k]
    },
  })
}
