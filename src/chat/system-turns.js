// 系统后台回合：独立 key 的 DSH 会话复用与串行执行，不写 QQ SessionRegistry 或旧 sessions.json。
export function createSystemTurns({ createSession, resolveAgent, onEvent, archiveSession, beforeTurn, log } = {}) {
  const sessions = new Map()
  const creating = new Map()
  const running = new Set()
  const active = new Set()
  let disposed = false

  async function sessionFor(key, title, noTools) {
    const hit = sessions.get(key)
    if (hit) return hit
    if (creating.has(key)) return creating.get(key)
    const pending = Promise.resolve(createSession({ key, title, noTools })).then((created) => {
      if (!created?.sessionId) throw new Error('DSH 创建系统会话未返回 sessionId')
      const entry = { sessionId: String(created.sessionId) }
      sessions.set(key, entry)
      return entry
    }).finally(() => creating.delete(key))
    creating.set(key, pending)
    return pending
  }

  async function execute(key, title, prompt, { timeoutMs = 180000, noTools = false } = {}) {
    const { sessionId } = await sessionFor(key, title, noTools)
    const resolved = await resolveAgent(sessionId)
    const agent = resolved?.agent
    if (!agent?.followup) throw new Error(`系统会话 ${sessionId} 没有 agent.followup`)
    await beforeTurn?.(agent, sessionId, { key, title, noTools })

    let off = null
    let timer = null
    let settled = false
    const state = {
      // 审计 Q04：dispose() 必须能兑现「正在等这一轮」的调用方。
      // 过去只清监听和定时器，promise 永远悬着 —— run() 的调用方拿到的是
      // 一个既不会 resolve 也不会 reject 的 promise，而 running 集合已经清空，
      // 于是「卸载」看起来成功、实际留下永久挂起的等待。
      // 这里把 settle 函数挂在 state 上，由 cleanup 之外的路径显式调用。
      settle: null,
      cleanup() {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        try { off?.() } catch {}
        active.delete(state)
        running.delete(key)
      },
    }
    state.key = key
    active.add(state)
    const result = new Promise((resolve, reject) => {
      let lastTurn = null
      let lastText = ''
      let expired = false
      const finish = (fn, value) => {
        if (settled) return
        state.cleanup()
        fn(value)
      }
      state.settle = (error) => {
        if (settled) return
        state.cleanup()
        reject(error)
      }
      off = onEvent((session, event) => {
        if (String(session?.id || '') !== sessionId) return
        if (event?.type === 'assistant/message') {
          const data = event.data || {}
          if (data.interrupted) return
          const text = (data.message?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('')
          if (text) { lastTurn = data.turn; lastText = text }
          return
        }
        if (event?.type !== 'turn/end') return
        if (expired) { state.cleanup(); return }
        const data = event.data || {}
        if (data.reason?.kind !== 'completed') { finish(reject, new Error(`系统回合未正常结束：${data.reason?.kind || '?'}`)); return }
        finish(resolve, lastTurn === data.turn ? String(lastText || '') : '')
      })
      if (typeof off !== 'function') { finish(reject, new Error('DSH 没有 session/event 流')); return }
      timer = setTimeout(() => {
        expired = true
        // 审计 P1：旧任务在底层可能仍在运行。如果不清理 sessions 映射，重试会复用同一个 session；
        // 随后旧任务产生的 assistant/message 与 turn/end 会被新重试的监听捕获，导致旧答案兑现新请求。
        // 因此超时必须废弃该 session 映射，让下一次请求创建隔离的新会话。
        sessions.delete(key)
        try { Promise.resolve(archiveSession?.(sessionId, { stopActivity: true })).catch((error) => log?.debug?.(`归档超时系统会话失败：${error?.message || error}`)) } catch (error) { log?.debug?.(`归档超时系统会话失败：${error?.message || error}`) }
        state.cleanup()
        reject(new Error('等太久了'))
      }, Math.max(1, Number(timeoutMs) || 180000))
      Promise.resolve(agent.followup({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: String(prompt || '') }], source: { kind: 'qq-hub' } }))
        .catch((error) => finish(reject, error))
    })
    return result
  }

  function run(name, title, prompt, opts = {}) {
    if (disposed) return Promise.reject(new Error('系统回合服务已卸载'))
    const scope = String(opts.key || '').trim().replace(/[^\w:-]/g, '').slice(0, 32)
    const key = `system:${String(name || '')}${scope ? `:${scope}` : ''}`
    if (running.has(key)) return Promise.reject(new Error('这个后台会话的上一轮还没结束'))
    running.add(key)
    return execute(key, title, prompt, opts).catch((error) => {
      if (!active.size || ![...active].some((state) => state.key === key)) running.delete(key)
      throw error
    })
  }

  function resetSessions() {
    const entries = [...sessions.values()]
    sessions.clear()
    for (const entry of entries) {
      try { Promise.resolve(archiveSession?.(entry.sessionId, { stopActivity: true })).catch((error) => log?.debug?.(`归档系统会话失败：${error?.message || error}`)) } catch (error) { log?.debug?.(`归档系统会话失败：${error?.message || error}`) }
    }
    return entries.length
  }

  async function dispose() {
    disposed = true
    // 先逐个兑现等待者，再清账：顺序反过来的话，settle 里的 running.delete 会对着
    // 已经清空的集合操作，日志与状态都对不上。
    for (const state of [...active]) state.settle?.(new Error('系统回合服务已卸载'))
    for (const state of [...active]) state.cleanup()
    sessions.clear()
    creating.clear()
    running.clear()
  }

  return { run, resetSessions, dispose }
}
