// QQ Hub · 面板路由：人格管理（host.js 分层拆出）
//
// 保存/切换人格后立刻重置正在用旧人设的会话：静态前缀 {{qq_hub_persona}} 是建会话时
// 固化的，光改文件旧会话拿不到；不重置的话新旧两段人设会在历史里打架。

import { listPersonas, readPersona, savePersona, deletePersona, personaIdFor, personaHash, currentPersonaText } from '../../persona/personas.js'
import { chatViewFromKey } from '../../chat/adapters/legacy-context.js'
import { askModel } from '../../core/llm.js'

export function registerPersonaRoutes({
  route, readBody, query,
  ctx, getConfig, setConfig,
  hub, log,
}) {
  // 人格
  route('/personas', async () => ({ ok: true, list: listPersonas(), current: getConfig().persona.current }))
  route('/persona/get', async (req) => {
    const p = readPersona(query(req).id)
    return p ? { ok: true, persona: p } : { ok: false, message: '没有这个人格' }
  })
  route('/persona/save', async (req) => {
    const b = await readBody(req)
    const p = savePersona(b.id, b)
    // 人设正文变了：还在用旧正文的会话要重置（P1-4）。静态前缀 {{qq_hub_persona}} 是建会话时
    // 固化的，光改文件旧会话拿不到；不重置的话新旧两段人设会在历史里打架（P0-5 同根因）。
    let reset = 0
    try {
      for (const [chatId, entry] of Object.entries(hub.sessions() || {})) {
        if (entry.personaId === b.id) { hub.resetChat(chatId); reset++ }
      }
    } catch (error) {
      log.debug('人设保存后重置会话出错：', error.message)
    }
    return { ok: true, persona: p, message: reset > 0 ? `人格已保存，${reset} 个正在用的会话已重置，下一轮起生效` : '人格已保存，下一轮起生效' }
  })
  /**
   * 人设生效自检：每个聊天「该用哪张卡」vs「会话里实际固化的那张卡」。
   *
   * 为什么要这个接口：人设是**建会话那一刻**烧进系统提示词的，之后 DSH 不重算；
   * 于是「面板上配好了」和「模型实际拿到什么」完全是两回事，用户只看得到后者。
   * 以前只能靠猜（2026-11-23 排查花了半小时读会话文件才确认）。这里一次说清：
   *   expected —— 按当前配置该用的卡与这版正文指纹
   *   live     —— 会话里记着的卡与指纹（为空 = 这个聊天还没有会话）
   *   stale    —— 下一条消息进来时会不会被重建
   *   source   —— 这个期望值是哪一层配置决定的（专卡 / 群默认 / 全局 / 空值回落）
   */
  route('/persona/audit', async () => {
    const cfg = getConfig()
    const sessions = (() => { try { return hub.sessions?.() || {} } catch { return {} } })()
    const names = new Map()
    try {
      for (const c of (hub.knownChats?.() || [])) names.set(String(c.chatId), String(c.rawName || c.name || ''))
    } catch { /* 群名只是显示用 */ }

    const chats = new Set(Object.keys(sessions))
    const persona = cfg.persona || {}
    for (const gid of Object.keys(persona.groups || {})) chats.add(`group:${gid}`)
    for (const uid of Object.keys(persona.privates || {})) chats.add(`private:${uid}`)
    for (const gid of (cfg.allow?.groups || [])) chats.add(`group:${gid}`)
    if (cfg.ownerQQ) chats.add(`private:${cfg.ownerQQ}`)

    const rows = []
    for (const chatId of [...chats].sort()) {
      let view = null
      try { view = chatViewFromKey(chatId) } catch { continue }
      const id = personaIdFor(view, cfg)
      const hash = personaHash(id)
      const card = id ? readPersona(id) : null
      const live = sessions[chatId]
      rows.push({
        chatId,
        chatName: names.get(chatId) || '',
        expected: { id, name: card?.name || '', hash },
        live: live ? { sessionId: live.sessionId || '', id: live.personaId || '', hash: live.personaHash || '' } : null,
        stale: live ? (String(live.personaId || '') !== id || String(live.personaHash || '') !== hash) : null,
        source: personaSourceOf(view, cfg),
      })
    }
    return {
      ok: true,
      current: { id: persona.current || '', name: (persona.current && readPersona(persona.current)?.name) || '', hash: personaHash(persona.current) },
      globalText: currentPersonaText(persona.current).slice(0, 40),
      rows,
    }
  })

  /**
   * 按「预期卡 vs 会话里固化的卡」重建过期会话。
   *
   * 默认只出清单（dryRun），要真重建得显式传 dryRun:false。为什么要这个接口：
   * 人设改动只有在**重建会话**时才生效，而面板上你分不清「哪些聊天还挂着旧正文」。
   * 存量数据里那些「老映射没记指纹」的（personaHashAssumed）单独列出来，默认不动 ——
   * 猜的基线不能当已知，重建不重建由主人决定。
   */
  route('/persona/rebuild-stale', async (req) => {
    const body = (await readBody(req)) || {}
    const dryRun = body.dryRun !== false
    const includeAssumed = body.includeAssumed === true
    const cfg = getConfig()
    const sessions = (() => { try { return hub.sessions?.() || {} } catch { return {} } })()
    const stale = []
    const assumed = []
    const kept = []
    for (const [chatId, entry] of Object.entries(sessions)) {
      let view = null
      try { view = chatViewFromKey(chatId) } catch { continue }
      const wantId = personaIdFor(view, cfg)
      const wantHash = personaHash(wantId)
      const liveId = String(entry?.personaId || '')
      const liveHash = String(entry?.personaHash || '')
      const row = {
        chatId,
        sessionId: String(entry?.sessionId || ''),
        expected: { id: wantId, hash: wantHash },
        live: { id: liveId, hash: liveHash },
        assumed: entry?.personaHashAssumed === true,
      }
      if (row.assumed && !includeAssumed) { assumed.push(row); continue }
      if (liveId !== wantId || liveHash !== wantHash) stale.push(row)
      else kept.push(row)
    }
    let rebuilt = 0
    const failed = []
    if (!dryRun) {
      for (const row of stale) {
        try { if (hub.resetChat?.(row.chatId)) rebuilt++ } catch (error) { failed.push({ chatId: row.chatId, error: String(error?.message || error) }) }
      }
    }
    return {
      ok: failed.length === 0,
      dryRun,
      stale,
      assumed,
      kept: kept.length,
      rebuilt,
      failed,
      message: dryRun
        ? `查出 ${stale.length} 个会话挂着旧人设${assumed.length ? `，另有 ${assumed.length} 个正文版本无法确认` : ''}（还没动）`
        : `重建了 ${rebuilt} 个会话${failed.length ? `，${failed.length} 个失败` : ''}${assumed.length ? `；${assumed.length} 个版本无法确认的没动` : ''}`,
    }
  })

  route('/persona/delete', async (req) => {
    const b = await readBody(req)
    if (b.id === getConfig().persona.current) return { ok: false, message: '正在用的人格不能删' }
    deletePersona(b.id)
    return { ok: true, list: listPersonas() }
  })
  route('/persona/use', async (req) => {
    const b = await readBody(req)
    if (!readPersona(b.id)) return { ok: false, message: '没有这个人格' }
    // 变更前先留一份配置快照：重置判定要用「旧预期人设 vs 新预期人设」，
    // 而不是拿会话里的 personaId 去比已改过的 current（那样恒不相等 / 恒相等，两种都错）。
    const before = getConfig()
    // 只改 current，别把 persona 整块替换掉——否则按聊天配的人设会被一起清空
    setConfig({ ...before, persona: { ...(before.persona || {}), current: b.id } })
    log.info(`切换人格 → ${b.id}`)
    // 切完立刻重置受影响的会话：旧历史里的人设块清不掉，模型会逐条仲裁新旧人设。
    // 判定口径统一在核心侧（resetChatsForPersonaChange），这里只负责调用和如实回报。
    let changed = []
    try { changed = hub.resetChatsForPersonaChange?.(before) || [] } catch (error) {
      log.debug('切换人格后重置会话出错：', error.message)
    }
    const left = countFollowing(before, b.id)
    const msg = changed.length
      ? `切换好了，${changed.length} 个会话已重置，下一轮起按「${readPersona(b.id).name}」回`
      : (left > 0
        ? `切换好了，但 ${left} 个会话用着单独指定的人设，不受全局切换影响；要一起换请在下面「按群聊/私聊分开设人设」里把它们改成「跟随全局人设」`
        : '切换好了，下一轮回复起生效')
    return { ok: true, current: b.id, reset: changed.length, changed, message: msg }
  })

  /**
   * 有多少会话的人设不受这次全局切换影响（被单独指定或群/私聊默认钉住了）。
   * 只用于如实回报，不参与任何重置决策。
   */
  function countFollowing(oldCfg, newCurrent) {
    try {
      const sessions = hub.sessions() || {}
      let n = 0
      for (const chatId of Object.keys(sessions)) {
        const chat = chatId.startsWith('group:') ? { kind: 'group', groupId: chatId.slice(6) }
          : chatId.startsWith('private:') ? { kind: 'private', userId: chatId.slice(8) } : { kind: 'system' }
        const want = personaIdFor(chat, getConfig())
        // 预期仍是旧全局卡 = 它没跟上这次切换
        if (want && want === personaIdFor(chat, oldCfg)) n++
      }
      return n
    } catch { return 0 }
  }
  // 人格页「AI 润色」：只改面板上这一节的文字，不保存；用不用由主人在面板里选
  route('/persona/polish', async (req) => {
    const b = await readBody(req)
    const title = String(b.title || '').slice(0, 30) || '开场（她是谁）'
    const text = String(b.text || '').slice(0, 4000)
    const others = (Array.isArray(b.others) ? b.others : []).map((x) => String(x).slice(0, 30)).slice(0, 20)
    const system = '你在帮人改一个 QQ 聊天角色的人设。人设按【标题】分节，你一次只改其中一节。' +
      '只输出这一节改好后的正文：不要写标题，不要加粗、不要 Markdown 标题，不要任何解释。原来是「- 」开头的条目就继续用条目，一条一行、短句。'
    const ask = [
      `角色：${String(b.name || '她').slice(0, 30)}`,
      `要改的这一节：${title}`,
      `人设里另外几节：${others.join('、') || '无'}（只是让你知道还有哪些，别把它们的内容写进这一节）`,
      text.trim()
        ? '要求：保留原来的设定和事实，不编新的身份信息；说得更具体、更像真人；删掉重复和空话；长度别超过原来的 1.5 倍。'
        : '要求：这一节还是空的，按这个角色和这一节的标题写 4 到 8 条。',
      text.trim() ? `原文：\n${text}` : '',
    ].filter(Boolean).join('\n')
    try {
      const out = String(await askModel(ctx, { cfg: getConfig(), system, text: ask, maxTokens: 1500, temperature: 0.6 }) || '')
        .replace(/^```[a-z]*\n?|\n?```$/g, '').replace(new RegExp('^【' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '】\\s*'), '').trim()
      return out ? { ok: true, text: out } : { ok: false, message: '模型没给出内容，再试一次' }
    } catch (error) {
      return { ok: false, message: '润色没成功：' + error.message }
    }
  })
}

/**
 * 这个聊天的期望人设是哪一层决定的：专卡 / 群·私聊默认 / 全局。
 * 空值行（面板「添加」了但没选卡）要显式说成「该行是空值，跟随默认」，
 * 否则面板上看着配过、实际一直走默认（2026-11-23 真机：955741432 就是空值行）。
 */
export function personaSourceOf (chat, cfg) {
  const p = cfg?.persona || {}
  const kind = chat?.kind
  if (kind === 'group') {
    const gid = String(chat.groupId || '')
    const own = p.groups?.[gid]
    if (typeof own === 'string' && own.trim()) return { level: 'group', explicit: true }
    if (Object.prototype.hasOwnProperty.call(p.groups || {}, gid)) return { level: 'groupDefault', emptyRow: true }
    if (typeof p.groupDefault === 'string' && p.groupDefault.trim()) return { level: 'groupDefault' }
  }
  if (kind === 'private') {
    const uid = String(chat.userId || '')
    const own = p.privates?.[uid]
    if (typeof own === 'string' && own.trim()) return { level: 'private', explicit: true }
    if (Object.prototype.hasOwnProperty.call(p.privates || {}, uid)) return { level: 'privateDefault', emptyRow: true }
    if (typeof p.privateDefault === 'string' && p.privateDefault.trim()) return { level: 'privateDefault' }
  }
  return { level: 'global' }
}
