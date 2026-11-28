// 模型同步：把面板当前选定的模型立刻应用到**所有已有会话**（从 host/modular-core.js 原样搬出）。
//
// 为什么单独成模块：原来只在对方发下一条消息时才跟着配置切模型，冷群可能几小时不动，
// 主人看到的就是「配了没生效」（2026-11-04 反馈）。这条链只服务「立刻应用」这个动作，
// 与回合执行无关，搬出来后装配根只留一次调用。
//
// 依赖全是注入的活引用 / 函数：registry 是同一份会话映射，selectedModels 是同一份
// sessionId→模型键表（applySessionModel 也在写），sessionPersonas 是同一份人设账
//（失效会话要连它一起清）。本模块不持有任何状态。

/**
 * @param {object} o
 * @param {() => object} o.getConfig 每轮读最新配置
 * @param {object} o.log 日志
 * @param {object} o.registry 会话注册表（snapshot / peek / forget）
 * @param {(chat: object) => Promise<object|null>} o.resolveTarget 按聊天解析目标模型
 * @param {(agent: object, sessionId: string, target: object) => Promise<boolean>} o.applySessionModel
 * @param {(sessionId: string) => void} o.cleanupSession 会话级清理（图片额度/工具/上下文）
 * @param {(name: string) => object|null} o.ctxGet 取宿主服务（sessionController）
 * @param {Map<string, object>} o.sessionPersonas 人设账（活引用）
 * @param {Map<string, string>} o.selectedModels 已应用模型键（活引用）
 * @param {(chatKey: string, members?: Array) => object} o.chatViewFor ChatKey → chat 视图
 * @param {(target: object) => string} o.modelKey 目标模型 → 比较键
 */
export function createModelSync({
  getConfig, log, registry, resolveTarget, applySessionModel, cleanupSession,
  ctxGet, sessionPersonas, selectedModels, chatViewFor, modelKey,
}) {
  async function syncAllModels() {
    let applied = 0
    let skipped = 0
    let failed = 0
    let dropped = 0
    const detail = []
    for (const [chatId, entry] of Object.entries(registry.snapshot())) {
      const sessionId = String(entry?.sessionId || '')
      if (!sessionId) { skipped++; continue }
      let want = ''
      try {
        const target = await resolveTarget(chatViewFor(chatId))
        want = modelKey(target)
        if (!want || selectedModels.get(sessionId) === want) { skipped++; continue }
        const ctrl = ctxGet('sessionController')
        if (!ctrl?.resolveAgent) throw new Error('DSH 没有 sessionController.resolveAgent')
        const resolved = await ctrl.resolveAgent(sessionId)
        if (!resolved?.agent) throw new Error(resolved?.error?.message || resolved?.error?.code || 'no session')
        if (registry.peek(chatId)?.sessionId !== sessionId) { skipped++; continue }
        if (!await applySessionModel(resolved.agent, sessionId, target)) throw new Error('会话模型选择不可用')
        applied++
        detail.push({ chatId, want, ok: true })
      } catch (error) {
        failed++
        const item = { chatId, ...(want ? { want } : {}), ok: false, error: String(error?.message || error) }
        if (/not[ -]found|不存在|已归档|no session/i.test(item.error) && registry.peek(chatId)?.sessionId === sessionId) {
          cleanupSession(sessionId)
          sessionPersonas.delete(chatId)
          registry.forget(chatId)
          item.dropped = true
          dropped++
        }
        detail.push(item)
      }
    }
    return { applied, skipped, failed, dropped, detail }
  }

  return { syncAllModels }
}