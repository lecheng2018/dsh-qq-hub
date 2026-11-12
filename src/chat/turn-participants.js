import { isOwner } from './access.js'

// 当前回合的说话人与权限证据；不再寄存在 legacy hub 的 turnState。
export function createTurnParticipants({ getConfig, chatOfSession }) {
  const states = new Map()
  const keyOf = (sessionId) => {
    const key = String(sessionId || '')
    return key.startsWith('session-') ? key.slice(8) : key
  }
  const stateOf = (sessionId) => states.get(keyOf(sessionId))

  function note(sessionId, senders = [], opts = {}) {
    const key = keyOf(sessionId)
    if (!key) return
    const state = states.get(key) || { lastTurn: -1, text: '', senders: new Set() }
    const list = (senders || []).map(String).filter(Boolean)
    state.speakers = list
    state.senders = new Set(list)
    if (opts.queryText != null) {
      if (state.lastText) state.prevText = state.lastText
      state.lastText = String(opts.queryText).slice(-600)
    }
    if (opts.directOwner !== undefined) state.directOwner = Boolean(opts.directOwner)
    states.set(key, state)
  }

  function onSessionEvent(session, event) {
    const sid = String(session?.id || '')
    if (!chatOfSession(sid)) return
    if (event?.type === 'user/message' && event?.data?.source?.kind === 'user') note(sid, stateOf(sid)?.speakers || [], { directOwner: true })
    else if (event?.type === 'turn/end') note(sid, stateOf(sid)?.speakers || [], { directOwner: false })
  }

  function ownerPrivateChat(sessionId) {
    try { return chatOfSession(sessionId) === `private:${getConfig().ownerQQ}` } catch { return false }
  }

  function turnHasOwner(sessionId) {
    const state = stateOf(sessionId)
    if (state?.directOwner) return true
    if (state && [...state.senders].some((uid) => isOwner(getConfig(), uid))) return true
    return ownerPrivateChat(sessionId)
  }

  function turnSendersAllOwner(sessionId) {
    const state = stateOf(sessionId)
    if (state?.directOwner) return true
    if (!state || !state.senders.size) return ownerPrivateChat(sessionId)
    return [...state.senders].every((uid) => isOwner(getConfig(), uid))
  }

  function turnHasUniqueImageGenOwnerRequester(sessionId, requests = []) {
    const state = stateOf(sessionId)
    const chatId = chatOfSession(sessionId) || ''
    if (!chatId.startsWith('group:') || !state || state.directOwner) return false
    const senders = new Set([...(state.senders || [])].map(String))
    const query = String(state.lastText || '')
    const requesters = new Set()
    for (const request of requests || []) {
      const uid = String(request?.userId || '')
      const text = String(request?.text || '').trim()
      if (uid && senders.has(uid) && text && query.includes(text)) requesters.add(uid)
    }
    return requesters.size === 1 && isOwner(getConfig(), requesters.values().next().value)
  }

  return {
    note,
    onSessionEvent,
    turnHasOwner,
    turnSendersAllOwner,
    turnHasUniqueImageGenOwnerRequester,
    lastTextOf: (sessionId) => stateOf(sessionId)?.lastText || '',
    prevTextOf: (sessionId) => stateOf(sessionId)?.prevText || '',
    speakersOf: (sessionId) => stateOf(sessionId)?.speakers || [],
    simulateTurn: (sessionId, senders) => { states.set(keyOf(sessionId), { lastTurn: -1, text: '', senders: new Set(senders.map(String)) }) },
    clear: (sessionId) => states.delete(keyOf(sessionId)),
  }
}
