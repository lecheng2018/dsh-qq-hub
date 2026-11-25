// 生产唯一 hub facade：只组合当前核心与独立服务，不创建或转发 legacy hub。
export function createCurrentHub({
  modular, chatLog, recentMedia, inboundAudio, interactions, stickerOf, stickers, getConfig, log, egress,
}) {
  const services = modular.services

  function logChat(chatId, who, text, uid = '') {
    try { return chatLog?.append?.(chatId, who, text, uid) } catch { return undefined }
  }

  function interceptInteraction({ text, userId, chatId, who } = {}) {
    try {
      if (interactions.approvals.handleReply(text, userId, chatId)) { logChat(chatId, who || '', text, userId); return true }
      if (interactions.questions.has(chatId) && interactions.questions.handleReply(chatId, text, userId)) { logChat(chatId, who || '', text, userId); return true }
    } catch (error) { log?.debug?.('旁路指令判定出错：', error.message) }
    return false
  }

  function resetSessions() {
    interactions.approvals.clear('会话重置')
    const ids = Object.keys(modular.registry.snapshot())
    for (const chatId of ids) modular.resetChat(chatId)
    return ids.length + modular.resetSessions()
  }

  const facade = {
    ...services,
    runPromptTurn: modular.runPromptTurn,
    runSystemTurn: modular.runSystemTurn,
    syncAllModels: modular.syncAllModels,
    sessions: modular.sessions,
    knownChats: modular.knownChats,
    resetSessions,
    sweepOrphanSessions: modular.sweepOrphanSessions,
    markTurnAt: modular.markTurnAt,
    chatOfSession: modular.chatKeyOfSession,
    isSystemSession: modular.isSystemSession,
    resetChat: modular.resetChat,
    // 人设变更后按「新旧预期人设」逐聊天比对并重置：面板切卡/改默认人设统一走这一条，
    // 不再靠 sessions() 视图里的 personaId 猜（那只是建会话那一刻的快照，改了默认值不会动）。
    resetChatsForPersonaChange: (oldConfig) => {
      try { return modular.resetChatsForPersonaChange(oldConfig) || [] } catch (error) {
        log?.debug?.('人设变更重置会话出错：', error?.message || error)
        return []
      }
    },
    onMessage: (event) => modular.dispatchLegacyEventSettled({ post_type: 'message', time: Math.floor(Date.now() / 1000), ...event }),
    onPoke: (event) => modular.dispatchLegacyEventSettled(event),
    questions: interactions.questions,
    approvals: interactions.approvals,
    askUserQuestion: (chatId, req) => interactions.questions.ask(chatId, req),
    requestApproval: (req, opts) => interactions.approvals.request(req, opts),
    interceptInteraction,
    recentMedia: (chatId, userId) => recentMedia.get(chatId, userId),
    noteRecentMedia: (chatId, segs, userId) => { try { recentMedia.rememberSegments(String(chatId), segs, userId) } catch {} },
    disposeRecentMedia: () => recentMedia.dispose(),
    localTranscribe: (rec) => inboundAudio.transcribeLocally(rec),
    stickerOf,
    collectInboundSticker: async (seg, chatId) => {
      try {
        const cfg = getConfig()
        if (!cfg.stickers?.enabled || !cfg.stickers?.collect) return { ok: false, reason: '偷表情关着' }
        return await stickers.collect(seg, chatId)
      } catch (error) { return { ok: false, reason: String(error.message || error) } }
    },
    logChat,
    chatLogOf: (day) => chatLog?.readDay?.(day) || [],
    chatLogDays: () => chatLog?.listDays?.() || [],
    deliverRaw: (args = {}) => {
      const chatKey = args.chatKey || (args.params?.group_id ? `group:${args.params.group_id}` : args.params?.user_id ? `private:${args.params.user_id}` : '')
      if (!chatKey) throw new Error('deliverRaw 缺 chatKey，拒绝无会话域发送')
      return egress.deliver({ ...args, chatKey, receipt: args.receipt || 'required', sourceModuleId: args.sourceModuleId || 'module' })
    },
    get lastChatAt() { return services.lastChatAt() },
    get lastOwnerChatAt() { return services.lastOwnerChatAt() },
    get lastBotToOwner() { return services.lastBotToOwner() },
    get selfId() { return services.selfId() },
  }
  return Object.freeze(facade)
}
