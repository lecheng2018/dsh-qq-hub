// 系统后台回合：独立 key 的 DSH 会话复用与串行执行，不写 QQ SessionRegistry 或旧 sessions.json。
export function createSystemTurns({ createSession, resolveAgent, onEvent, archiveSession, beforeTurn, log } = {}) {
  const sessions = new Map()
  const creating = new Map()
  const running = new Set()
  const active = new Set()
  let disposed = false

  async function sessionFor(key, title, noTools) {
    if (disposed) throw new Error('系统回合服务已卸载')
    const hit = sessions.get(key)
    if (hit) return hit
    if (creating.has(key)) return creating.get(key)
    const pending = Promise.resolve(createSession({ key, title, noTools })).then((created) => {
      if (!created?.sessionId) throw new Error('DSH 创建系统会话未返回 sessionId')
      // 审计 T3.9：createSession 可能耗时很久，期间模块被卸载（dispose 已清空 sessions）——
      // 这里若继续写回 sessions，会留下一个「卸载后仍存活」的会话，后续 resetSessions 也收不到它。
      if (disposed) throw new Error('系统回合服务已卸载')
      const entry = { sessionId: String(created.sessionId) }
      sessions.set(key, entry)
      return entry
    }).finally(() => creating.delete(key))
    creating.set(key, pending)
    return pending
  }

  async function execute(key, title, prompt, { timeoutMs = 180000, noTools = false } = {}) {
    if (disposed) throw new Error('系统回合服务已卸载')
    const { sessionId } = await sessionFor(key, title, noTools)
    // 审计 T3.9：每个 await 之后都要复查 disposed —— 卸载后再继续只会给一个
    // 已经没人收的会话挂监听/定时器（active 集合已清空，settle 永远不会被调用）。
    if (disposed) throw new Error('系统回合服务已卸载')
    const resolved = await resolveAgent(sessionId)
    if (disposed) throw new Error('系统回合服务已卸载')
    const agent = resolved?.agent
    if (!agent?.followup) throw new Error(`系统会话 ${sessionId} 没有 agent.followup`)
    await beforeTurn?.(agent, sessionId, { key, title, noTools })
    if (disposed) throw new Error('系统回合服务已卸载')

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
      // 注意：这里**不能** unref。系统回合唯一的落定路径就是这个超时定时器；
      // unref 后若事件循环没有别的 ref 句柄（Node 22 的 test runner / CI 形态），
      // Node 会判定事件循环已排空，await 永远等不到并被标 cancelledByParent。
      // 退出问题由 dispose() 统一 clearTimeout 解决。
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

  /**
   * 当前还活着的系统会话 id（孤儿巡检要用：这些会话即便不在 QQ 聊天映射里，
   * 也仍然是「正在复用的后台会话」，绝不能当成孤儿归档掉）。
   * @returns {string[]}
   */
  function liveSessionIds() {
    return [...sessions.values()]
      .map((entry) => String(entry?.sessionId || ''))
      .filter(Boolean)
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

  return { run, resetSessions, liveSessionIds, dispose }
}
