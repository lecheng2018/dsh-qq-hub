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
        if (timer) clearTimeout(timer)
        timer = null
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
      try { Promise.resolve(archiveSession?.(entry.sessionId)).catch((error) => log?.debug?.(`归档系统会话失败：${error?.message || error}`)) } catch (error) { log?.debug?.(`归档系统会话失败：${error?.message || error}`) }
    }
    return entries.length
  }

  async function dispose() {
    disposed = true
    for (const state of [...active]) state.cleanup()
    sessions.clear()
    creating.clear()
    running.clear()
  }

  return { run, resetSessions, dispose }
}
