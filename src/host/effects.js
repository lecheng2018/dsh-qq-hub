// QQ Hub · 宿主旁路 seam 安装器（host.js 分层拆出）
//
// 与消息管道正交的四个旁路：通用工具审批流（approval/request）、交互式提问
// （userQuestions）、会话事件监听、看门狗。
// 全部通过 install*/create* 在组合根按原顺序接线。

export function createHostEffects({
  ctx, logger, log, getConfig,
  hub, mods, use, snowluma, onebot, gatewayState, interactions,
  /** 会话 id → 当前核心的 chatKey 反查，由组合根决定唯一来源 */
  chatKeyOfSession,
  /** 当前核心的会话事件入口；legacy 直调模式才回退 hub.onSessionEvent。 */
  onSessionEvent,
}) {
  const sessionKey = (id) => {
    const s = String(id ?? '')
    return s.startsWith('session-') ? s.slice(8) : s
  }

  const chatOfSession = (sid) => {
    try { return (typeof chatKeyOfSession === 'function' ? chatKeyOfSession(sid) : '') || '' } catch { return '' }
  }

  // T3.6：插件被卸载（热重载）后，任何已经排上的 setTimeout 仍会醒来跑一次旧实例的闭包，
  // 于是旧实例又连回网关/新建会话（僵尸连接）。disposed 守卫让这些迟到回调空跑一次立刻退出。
  // 卸载时置位：注册在 ctx.effect 上，热重载/停用后由宿主统一回收。
  // 只声明不置位的 disposed 等于没有守卫 —— 旧实例的 setTimeout 醒来照样跑完闭包。
  let disposed = false
  const dispose = () => { disposed = true }
  try {
    ctx.effect(() => () => { disposed = true }, 'qq-hub: effects 卸载守卫')
  } catch (error) {
    // ctx 没有 effect（单测/老宿主）时退化为手动 dispose()，不影响其余接线
    log?.debug?.(`effects 卸载守卫注册失败：${error?.message || error}`)
  }
  const safe = (fn, label) => () => {
    if (disposed) return
    Promise.resolve().then(fn).catch((error) => log.warn(`${label}出错：`, error.message))
  }

  const resolveDisplayReason = (req) => {
    const dr = req?.displayReason
    if (typeof dr === 'string' && dr.trim()) return dr.trim()
    if (dr && typeof dr === 'object') {
      const picked = dr['zh-CN'] || dr.zh || dr['zh-Hans'] || dr.en
        || Object.values(dr).find((v) => typeof v === 'string' && v.trim())
      if (typeof picked === 'string' && picked.trim()) return picked.trim()
    }
    return String(req?.reason || '').trim()
  }

  // ---------- 通用工具审批流 (approval/request) ----------
  // 接入 DSH 官方 approval/request waterfall（Cordis 4 插件 ctx 直接挂 prepend 监听；
  // 不碰 ctx.root，不 monkey-patch ApprovalService.request 绕过审计对）。
  function installApprovalFlow() {
    ctx.effect(() => {
      let off = null
      try {
        if (typeof ctx.on === 'function') {
          off = ctx.on('approval/request', async (req, next) => {
            const rawSid = req?.agent?.session?.id || req?.agent?.id || ''
            const sid = sessionKey(rawSid)
            const chatId = chatOfSession(sid)
            log.debug(`审批事件到达：rawSid=${String(rawSid)} sid=${sid} chatId=${chatId || '(空)'} tool=${String(req?.toolName || req?.name || req?.tool || '?')}`)
            // 非 QQ 会话的 agent 请求，委托给下一个应答者（如 GUI）
            if (!chatId) return next()

            try {
              const args = req?.arguments || null
              const command = args?.command || ''
              const reason = resolveDisplayReason(req)
              const toolName = String(req?.toolName || req?.name || req?.tool || 'tool')
              log.info(`审批请求：${toolName} → ${chatId}`)
              const out = await interactions.approvals.request(
                { ...req, toolName, reason: reason || req?.reason || '' },
                { chatId, sessionId: sid, command, args, reason },
              )
              log.info(`审批结果：${out}（${toolName}）`)
              return out
            } catch (error) {
              log.warn('审批处理异常：', error.message)
              return 'rejected'
            }
          }, { prepend: true })
          log.info('已挂接 approval/request：QQ 会话的审批走 QQ 卡片')
        } else {
          log.debug('插件上下文缺少 ctx.on，跳过通用审批流挂接')
        }
      } catch (error) {
        log.debug('挂通用审批流失败：', error.message)
      }
      return () => {
        try { if (typeof off === 'function') off() } catch {}
      }
    }, 'qq-hub: 通用工具审批')
  }

  // ---------- 交互式提问 (userQuestions / ask_user_question) ----------
  // 优先走 DSH 官方 user-questions/request waterfall（{ prepend: true }）；
  // 若宿主无事件总线但提供 userQuestions 服务，通过 ctx.inject(['userQuestions'], ...) 惰性挂载避免启动竞态。
  function setupUserQuestions() {
    ctx.effect(() => {
      let off = null
      let uninject = null
      if (typeof ctx.on === 'function') {
        try {
          off = ctx.on('user-questions/request', async (req, next) => {
            const rawSid = req?.agent?.session?.id || req?.agent?.id || ''
            const sid = sessionKey(rawSid)
            const chatId = chatOfSession(sid)
            if (!chatId) return next()
            return await interactions.questions.ask(chatId, req)
          }, { prepend: true })
          log.info('已挂接 user-questions/request：QQ 会话的提问走 QQ 卡片')
        } catch (error) {
          log.debug('挂接 user-questions/request 失败：', error.message)
        }
      }
      if (!off) {
        const attachService = (uq) => {
          if (!uq || typeof uq.ask !== 'function') return null
          const original = uq.ask.bind(uq)
          const wrapped = async (req) => {
            const sid = sessionKey(req?.agent?.session?.id || req?.agent?.id)
            const chatId = chatOfSession(sid)
            if (chatId) return await interactions.questions.ask(chatId, req)
            return await original(req)
          }
          uq.ask = wrapped
          log.info('已接管 userQuestions 服务：QQ 会话的提问走 QQ 卡片')
          return () => {
            if (uq.ask === wrapped) uq.ask = original
          }
        }
        if (typeof ctx.inject === 'function') {
          try {
            let disposeInner = null
            const stopInject = ctx.inject(['userQuestions'], (subCtx) => {
              let uq = null
              try { uq = subCtx?.get?.('userQuestions') ?? subCtx?.userQuestions ?? null } catch {}
              disposeInner = attachService(uq)
              if (disposeInner) subCtx?.effect?.(() => () => { try { disposeInner?.() } catch {} disposeInner = null })
            })
            uninject = () => {
              try { disposeInner?.() } catch {}
              disposeInner = null
              try { if (typeof stopInject === 'function') stopInject() } catch {}
            }
          } catch (error) {
            log.debug('惰性挂载 userQuestions 失败：', error.message)
          }
        } else {
          let uq = null
          try { uq = ctx.get?.('userQuestions') } catch (error) {
            log.debug('DSH 没提供 userQuestions（跳过交互提问桥接）：', error.message)
          }
          uninject = attachService(uq)
        }
      }
      return () => {
        try { if (typeof off === 'function') off() } catch {}
        try { if (typeof uninject === 'function') uninject() } catch {}
      }
    }, 'qq-hub: QQ交互提问服务')
  }

  // ---------- 盯会话：一轮结束就发回 QQ ----------
  function installSessionWatcher() {
    ctx.effect(() => {
      const off = ctx.on('session/event', (session, event) => {
        try {
          if (typeof onSessionEvent === 'function') onSessionEvent(session, event)
          else hub.onSessionEvent(session, event)
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
    // 首轮延迟启动也交给 ctx.effect：卸载时连定时器一起清掉，而不是等它自己醒来撞 disposed。
    ctx.effect(() => {
      const timer = setTimeout(safe(watchdog, '看门狗'), 3000)
      timer.unref?.()
      return () => clearTimeout(timer)
    }, 'qq-hub: 看门狗首轮')
  }

  // ---------- 孤儿会话巡检 ----------
  // 重启后内存里的后台会话映射会丢，旧的后台会话（刷B站/逛热榜…）就再没人认领，
  // 只会一直挂在侧栏。这里按 orphanSweep.intervalHours 定期静默归档一次。
  // 启动后先等一会儿再跑第一轮：让活跃会话先就位，避免把「刚建好还没登记」的会话误判成孤儿。
  let lastSweepAt = 0
  async function sweepOrphans() {
    if (typeof hub.sweepOrphanSessions !== 'function') return
    const cfg = getConfig()
    if (cfg?.orphanSweep?.enabled === false) return
    const everyMs = Math.max(1, Number(cfg?.orphanSweep?.intervalHours) || 6) * 3600_000
    if (lastSweepAt && Date.now() - lastSweepAt < everyMs) return
    lastSweepAt = Date.now() // 先占位：单轮失败也不要每 30 秒重试
    // 具体归档日志统一由 hub.sweepOrphanSessions() 内部输出，避免重复打两条
    return await hub.sweepOrphanSessions()
  }
  function installOrphanSweeper() {
    const cfg = getConfig()
    if (cfg?.orphanSweep?.enabled === false) {
      log.info('孤儿会话巡检：已关闭（config.orphanSweep.enabled=false）')
      return
    }
    const hours = Math.max(1, Number(cfg?.orphanSweep?.intervalHours) || 6)
    const idle = Math.max(1, Number(cfg?.orphanSweep?.idleHours) || 6)
    log.info(`孤儿会话巡检：每 ${hours} 小时扫一次，闲置超过 ${idle} 小时的失联会话会静默归档`)
    ctx.effect(() => ctx.interval(safe(sweepOrphans, '孤儿会话巡检'), 30 * 60_000), 'qq-hub: 孤儿会话巡检')
    ctx.effect(() => {
      const timer = setTimeout(safe(sweepOrphans, '孤儿会话巡检'), 5 * 60_000)
      timer.unref?.()
      return () => clearTimeout(timer)
    }, 'qq-hub: 孤儿会话巡检首轮')
  }

  return {
    safe, watchdog, dispose,
    installApprovalFlow,
    setupUserQuestions,
    installSessionWatcher,
    installWatchdog,
    installOrphanSweeper,
    sweepOrphans,
  }
}
