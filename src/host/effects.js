// QQ Hub · 宿主旁路 seam 安装器（host.js 分层拆出）
//
// 与消息管道正交的四个旁路：通用工具审批流（approval/request）、交互式提问
// （userQuestions）、会话事件监听、看门狗。
// 全部通过 install*/create* 在组合根按原顺序接线。

export function createHostEffects({
  ctx, logger, log, getConfig,
  hub, mods, use, snowluma, onebot, gatewayState,
  /** 会话 id → chatKey 反查（新核心会话不在 legacy sessions.json 里，真机实测审批卡发不到 QQ） */
  chatKeyOfSession,
}) {
  const sessionKey = (id) => {
    const s = String(id ?? '')
    return s.startsWith('session-') ? s.slice(8) : s
  }

  /** 会话 → chatKey：先问新核心（开旗时的会话都在这），再退回 legacy hub。 */
  const chatOfSession = (sid) => {
    try {
      const k = typeof chatKeyOfSession === 'function' ? chatKeyOfSession(sid) : ''
      if (k) return k
    } catch { /* 忽略 */ }
    try { return hub.chatOfSession?.(sid) || '' } catch { return '' }
  }

  const safe = (fn, label) => () => { Promise.resolve().then(fn).catch((error) => log.warn(`${label}出错：`, error.message)) }

  // ---------- 通用工具审批流 (approval/request) ----------
  // 接入 DSH 官方 approval seam：当模型调用敏感工具触发审批时，向主人 QQ 发送审批卡（支持 TOTP 权限锁）
  function installApprovalFlow() {
    ctx.effect(() => {
      let off = null
      try {
        // 必须带 { global: true }：DSH 用 agent 作用域的 waterfall 派发审批
        // （dsh-user-approval: ctx.waterfall(scopeTarget(agent, agent), 'approval/request', …)），
        // 不带 global 的监听器收不到 → 审批只能弹在 GUI，QQ 永远没有卡（真机实测）。
        const rootCtx = ctx.root ?? ctx
        log.debug(`审批监听挂载位置：${rootCtx === ctx ? '插件 ctx（root 不可用）' : 'ctx.root'}`)
        off = rootCtx.on('approval/request', async (req, next) => {
          try {
            const rawSid = req.agent?.session?.id || req.agent?.id || ''
            const sid = sessionKey(rawSid)
            const chatId = chatOfSession(sid)
            // 诊断（真机排查用）：审批事件到底有没有进来、反查到哪个 chat（2026-11-09）
            log.debug(`审批事件到达：rawSid=${String(rawSid)} sid=${sid} chatId=${chatId || '(空)'} tool=${String(req?.toolName || req?.name || req?.tool || '?')}`)
            // 非 QQ 会话的 agent 请求，委托给下一个应答者
            if (!chatId) return next()

            let command = ''
            let args = null
            if (req.arguments) {
              args = req.arguments
              command = req.arguments.command || ''
            }
            return await hub.requestApproval(req, {
              chatId,
              sessionId: sid,
              command,
              args
            })
          } catch (error) {
            log.warn('审批处理异常：', error.message)
            return 'rejected'
          }
        }, { global: true })
      } catch (error) {
        log.debug('挂通用审批流失败：', error.message)
      }
      // 兜底（真机实测：waterfall 监听在 root/agent 作用域都收不到本版本派发的事件）：
      // 直接拿 approval 服务实例，把 request() 包一层——它内部才是真正派发 waterfall 的地方。
      // 命中 QQ 会话就自己发卡等批复，不命中就原样交回（GUI 照旧）。
      try {
        const svc = ctx.get?.('approval')
        if (svc && typeof svc.request === 'function' && !svc.__qqhubPatched) {
          const orig = svc.request.bind(svc)
          svc.request = async (req) => {
            try {
              const raw = req?.agent?.session?.id || req?.agent?.id || ''
              const chatId = chatOfSession(sessionKey(raw))
              if (chatId) {
                const args = req?.arguments || null
                log.info(`审批请求：${String(req?.toolName || 'tool')} → ${chatId}`)
                const out = await hub.requestApproval(req, { chatId, sessionId: raw, command: args?.command || '', args })
                log.info(`审批结果：${out}（${String(req?.toolName || 'tool')}）`)
                return out
              }
            } catch (error) { log.warn('QQ 审批处理失败，回退 GUI：', error.message) }
            return orig(req)
          }
          svc.__qqhubPatched = true
          log.info('已接管 approval 服务：QQ 会话的审批走 QQ 卡片')
        } else if (svc && svc.__qqhubPatched) {
          log.debug('approval 服务已由本插件接管（跳过重复包装）')
        } else {
          log.debug('拿不到 approval 服务实例，审批只弹 GUI')
        }
      } catch (error) { log.debug('接管 approval 服务失败：', error.message) }
      return () => { try { if (typeof off === 'function') off() } catch (error) {} }
    }, 'qq-hub: 通用工具审批')
  }

  // ---------- 交互式提问 (userQuestions / ask_user_question) ----------
  // 当前 DSH 的稳定入口是 userQuestions.ask() 服务方法；provider/registerProvider 不是该服务的公开 API。
  function setupUserQuestions() {
    let uq = null
    try { uq = ctx.get?.('userQuestions') } catch (error) {
      log.debug('DSH 没提供 userQuestions（跳过交互提问桥接）：', error.message)
    }
    if (!uq || typeof uq.ask !== 'function') return
    ctx.effect(() => {
      const original = uq.ask.bind(uq)
      const wrapped = async (req) => {
        const sid = sessionKey(req?.agent?.session?.id || req?.agent?.id)
        const chatId = chatOfSession(sid)
        if (chatId) return await hub.askUserQuestion(chatId, req)
        return await original(req)
      }
      uq.ask = wrapped
      log.info('已接管 userQuestions 服务：QQ 会话的提问走 QQ 卡片')
      return () => {
        if (uq.ask === wrapped) uq.ask = original
      }
    }, 'qq-hub: QQ交互提问服务')
  }

  // ---------- 盯会话：一轮结束就发回 QQ ----------
  function installSessionWatcher() {
    ctx.effect(() => {
      const off = ctx.on('session/event', (session, event) => {
        try {
          hub.onSessionEvent(session, event)
        } catch (error) {
          log.warn('会话事件处理出错：', error.message)
        }
        // 真实用量信号：assistant/message 带 usage，转给模块（token-guardian 判定压缩用）。
        // 纯内存转发，不落盘、不开关、面板无痕 —— 用量遥测面板功能已按需求移除。
        try {
          const d = event && event.data
          if (event.type === 'assistant/message' && d && d.usage) {
            const sid = session && session.id
            mods.emit('session/usage', {
              sessionId: sid ? String(sid) : '',
              chatId: (sid && chatOfSession(String(sid))) || '',
              model: (getConfig().model && getConfig().model.model) || '',
              usage: d.usage,
            })
          }
        } catch (error) { log.debug?.('用量转发出错：', error.message) }
      })
      return () => { try { if (typeof off === 'function') off() } catch (error) {} }
    }, 'qq-hub: 盯会话')
  }

  // ---------- 启动 / 看门狗 ----------
  async function watchdog() {
    const cfg = getConfig()
    if (!cfg.enabled) {
      if (onebot.state !== 'stopped') onebot.stop()
      return
    }
    const own = cfg.gateway === 'snowluma' // 接别人的 OneBot 时不启动、不注入 SnowLuma
    const inst = snowluma.detect()
    if (own && inst.installed && cfg.snowluma.autoStart && !(await snowluma.running())) {
      const r = await snowluma.start()
      log.info('SnowLuma：', r.message)
    }
    // 上次连上的不是机器人号：等主人手动点「接入机器人号」或改设置再连
    if (gatewayState.wrongAccount) return
    if (onebot.state === 'stopped') onebot.start()
    if (own && cfg.snowluma.autoAttach && cfg.snowluma.webuiPassword && gatewayState.onebotState !== 'connected' && (await snowluma.running())) {
      const last = snowluma.lastAttach
      if (Date.now() - last.at > 60_000) {
        const r = await snowluma.attachBot()
        log.info('接入机器人号：', r.message)
      }
    }
  }
  function installWatchdog() {
    ctx.effect(() => ctx.interval(safe(watchdog, '看门狗'), 30_000), 'qq-hub: 看门狗')
    setTimeout(safe(watchdog, '看门狗'), 3000).unref?.()
  }

  return {
    safe, watchdog,
    installApprovalFlow,
    setupUserQuestions,
    installSessionWatcher,
    installWatchdog,
  }
}
