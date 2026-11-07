// QQ Hub · 面板路由：人格管理（host.js 分层拆出）
//
// 保存/切换人格后立刻重置正在用旧人设的会话：静态前缀 {{qq_hub_persona}} 是建会话时
// 固化的，光改文件旧会话拿不到；不重置的话新旧两段人设会在历史里打架。

import { listPersonas, readPersona, savePersona, deletePersona } from '../../persona/personas.js'
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
  route('/persona/delete', async (req) => {
    const b = await readBody(req)
    if (b.id === getConfig().persona.current) return { ok: false, message: '正在用的人格不能删' }
    deletePersona(b.id)
    return { ok: true, list: listPersonas() }
  })
  route('/persona/use', async (req) => {
    const b = await readBody(req)
    if (!readPersona(b.id)) return { ok: false, message: '没有这个人格' }
    // 只改 current，别把 persona 整块替换掉——否则按聊天配的人设会被一起清空
    setConfig({ ...getConfig(), persona: { ...(getConfig().persona || {}), current: b.id } })
    log.info(`切换人格 → ${b.id}`)
    // 切完立刻重置正在用全局人设的会话：旧历史里的人设块清不掉，模型会逐条仲裁新旧人设
    //（agentFor 里按 personaId 比对的 hook 下一轮也会触发，这里提前到保存动作本身）。
    let reset = 0
    try {
      for (const [chatId, entry] of Object.entries(hub.sessions() || {})) {
        if (entry.personaId && entry.personaId === (getConfig().persona && getConfig().persona.current)) { hub.resetChat(chatId); reset++ }
      }
    } catch (error) {
      log.debug('切换人格后重置会话出错：', error.message)
    }
    return { ok: true, current: b.id, message: reset > 0 ? `切换好了，${reset} 个正在用的会话已重置，下一轮起生效` : '切换好了，下一轮回复起生效' }
  })
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
