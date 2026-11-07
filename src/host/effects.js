// QQ Hub · 宿主旁路 seam 安装器（host.js 分层拆出）
//
// 与消息管道正交的五个旁路：通用工具审批流（approval/request）、交互式提问
// （userQuestions）、桌宠端口注入（破端口自举死锁）、会话事件监听、看门狗。
// 全部通过 install*/create* 在组合根按原顺序接线。

export function createHostEffects({
  ctx, logger, log, getConfig,
  hub, mods, use, snowluma, onebot, gatewayState,
}) {
  const sessionKey = (id) => {
    const s = String(id ?? '')
    return s.startsWith('session-') ? s.slice(8) : s
  }

  const safe = (fn, label) => () => { Promise.resolve().then(fn).catch((error) => log.warn(`${label}出错：`, error.message)) }

  // ---------- 通用工具审批流 (approval/request) ----------
  // 接入 DSH 官方 approval seam：当模型调用敏感工具触发审批时，向主人 QQ 发送审批卡（支持 TOTP 权限锁）
  function installApprovalFlow() {
    ctx.effect(() => {
      let off = null
      try {
        off = ctx.on('approval/request', async (req, next) => {
          try {
            const sid = sessionKey(req.agent?.session?.id || req.agent?.id)
            const chatId = hub.chatOfSession?.(sid)
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
        })
      } catch (error) {
        log.debug('挂通用审批流失败：', error.message)
      }
      return () => { try { if (typeof off === 'function') off() } catch (error) {} }
    }, 'qq-hub: 通用工具审批')
  }

  // ---------- 交互式提问 (userQuestions / ask_user_question) ----------
  // 接入 DSH 官方 userQuestions seam：当模型通过 ask_user_question 提问时，格式化为 A/B/C 选项卡发往 QQ
  function setupUserQuestions() {
    // 读 ctx.userQuestions 时如果没在 inject 里声明，Cordis 会直接抛，所以整段包起来，
    // 而且做成「有就接、没有就跳过」，绝不能让交互提问这个可选能力把整个插件带崩。
    let uq = null
    try { uq = ctx.userQuestions } catch (error) { log.debug('DSH 没提供 userQuestions（跳过交互提问桥接）：', error.message) }
    if (!uq) { try { uq = ctx.get?.('userQuestions') } catch (error) {} }
    if (!uq) return
    if (uq.provider) {
      const orig = uq.provider
      uq.provider = {
        async ask(req) {
          const sid = sessionKey(req.agent?.session?.id || req.agent?.id)
          const chatId = hub.chatOfSession?.(sid)
          if (chatId) {
            return await hub.askUserQuestion(chatId, req)
          }
          return await orig.ask(req)
        }
      }
      log.info('已将 QQ 交互提问桥接接入现有 userQuestions 提供方')
    } else if (typeof uq.registerProvider === 'function') {
      try {
        ctx.effect(() => {
          const off = uq.registerProvider({
            async ask(req) {
              const sid = sessionKey(req.agent?.session?.id || req.agent?.id)
              const chatId = hub.chatOfSession?.(sid)
              if (chatId) {
                return await hub.askUserQuestion(chatId, req)
              }
              throw new Error('当前会话不在 QQ 机器人管辖内')
            }
          })
          return () => { try { if (typeof off === 'function') off() } catch (error) {} }
        }, 'qq-hub: QQ交互提问提供方')
        log.info('已成功注册 QQ userQuestions 交互提问提供方')
      } catch (error) {
        log.debug('注册 userQuestions 失败：', error.message)
      }
    }
  }

  // ---------- 桌宠端口注入（破「端口自举死锁」） ----------
  // pet 模块写 host.json 的 baseUrl 需要真实 Web 端口，而它自己监听不到（端口未知时只能写 null，
  // 客户端连不上 → 学不到 Host 头 → 死锁）。DSH 的 webServer 服务知道端口（ctx.webServer.port，
  // 取不到再退 DSH_WEB_URL）。注入时机：pet 每次启动/重载（module/start）+ boot 完成兜底各试一次；
  // Host 头学习仍保留，作端口漂移纠正。
  function webPortOf() {
    let port = Number(ctx?.webServer?.port)
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      try { port = Number(new URL(String(process.env.DSH_WEB_URL || '')).port) } catch { port = 0 }
    }
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0
  }
  function injectPetPort() {
    const port = webPortOf()
    if (!port) return false
    try { return Boolean(use('pet')?.setWebPort?.(port)) } catch { return false }
  }
  function installPetPortListener() {
    mods.listen('module/start', (id) => { if (id === 'pet') injectPetPort() })
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
        // 桌宠的「干活状态」动画 / 结束提醒：把同一条事件顺手转给 pet 模块（模块没开就是 null，纯旁路）
        try { use('pet')?.onSessionEvent?.(session, event) } catch (error) { log.debug?.('桌宠状态联动出错：', error.message) }
        // 真实用量信号：assistant/message 带 usage，转给模块（token-guardian 判定压缩用）。
        // 纯内存转发，不落盘、不开关、面板无痕 —— 用量遥测面板功能已按需求移除。
        try {
          const d = event && event.data
          if (event.type === 'assistant/message' && d && d.usage) {
            const sid = session && session.id
            mods.emit('session/usage', {
              sessionId: sid ? String(sid) : '',
              chatId: (sid && hub.chatOfSession?.(String(sid))) || '',
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
    installPetPortListener,
    injectPetPort,
    installSessionWatcher,
    installWatchdog,
  }
}
