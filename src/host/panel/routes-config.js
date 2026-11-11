// QQ Hub · 面板路由：总览 / 设置保存 / 工作区维护 / 会话重置（host.js 分层拆出）
//
// /save 是面板最重的一条：模型/人设/网关任一变更都要立刻联动（清探测缓存、同步已有
// 会话、重置人设会话、重启网关），行为逐字保留。

import { mergeFromPanel } from '../../core/config.js'
import { clearReasoningCache, clearVisionCache } from '../../core/llm.js'
import { personaIdFor } from '../../persona/personas.js'

export function registerConfigRoutes({
  route, readBody,
  dsh, // 宿主上下文别名：工作区路由原文引用 `dsh`（拆分前是隐式全局，这里显式注入修复 ReferenceError）
  getConfig, setConfig,
  snowluma, onebot, gatewayState, hub, getMods,
  overview, log, safe, watchdog,
}) {
  route('/state', async () => overview())

  // 工作区维护：宿主自带的删除入口在界面上，脚本化处理时没有门路，这里补两个只读/清理接口。
  // 背景：1.3.33 曾按聊天建子工作区（每个群一个「QQ Hub」），1.3.41 已改回共用主工作区，
  // 但那些已经建出来的子工作区要能被清掉（会话会落回「未分组」，文件夹自己删）。
  route('/workspaces/list', async () => {
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    if (!reg) return { ok: false, message: '宿主没有 workspaceRegistry' }
    return {
      ok: true,
      workspaces: reg.list().map((w) => ({ id: w.id, title: w.title || '', path: w.path || '', sessions: (w.sessionIds || []).length })),
    }
  })

  route('/workspaces/delete', async (req) => {
    const body = await readBody(req)
    const ids = (Array.isArray(body?.ids) ? body.ids : [body?.id])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
    if (!ids.length) return { ok: false, message: '没说要删哪个工作区' }
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    if (!reg) return { ok: false, message: '宿主没有 workspaceRegistry' }
    const done = []
    const failed = []
    for (const id of ids) {
      const ws = reg.list().find((w) => String(w.id) === id)
      if (!ws) {
        failed.push({ id, message: '没这个工作区' })
        continue
      }
      try {
        // 先把这个工作区里还挂着的 QQ 会话收掉，否则删完工作区，会话再开会找不到落脚点
        for (const [chatId, ent] of Object.entries(hub.sessions() || {})) {
          const sid = String(ent?.sessionId || '')
          if (sid && (ws.sessionIds || []).includes(sid)) {
            try {
              await hub.resetChat(chatId)
              log.info('删工作区前先收了会话：' + chatId)
            } catch (error) {
              log.warn('收会话失败：' + chatId, error.message)
            }
          }
        }
        reg.delete(id)
        done.push({ id, title: ws.title || '', path: ws.path || '' })
        log.info('删掉工作区：' + (ws.title || '') + '（' + (ws.path || '') + '）')
      } catch (error) {
        failed.push({ id, message: error.message })
      }
    }
    return { ok: failed.length === 0, done, failed }
  })

  route('/save', async (req) => {
    const body = await readBody(req)
    const before = getConfig()
    // 控制台密码不能只改配置（SnowLuma 那边还是旧的）：拿出来单独去 SnowLuma 改
    const newPw = typeof body?.snowluma?.webuiPassword === 'string' ? body.snowluma.webuiPassword : ''
    if (body?.snowluma) delete body.snowluma.webuiPassword
    const cfg = setConfig(mergeFromPanel(before, body))
    let pw = null
    if (newPw && newPw !== before.snowluma.webuiPassword) pw = await snowluma.setPassword(newPw)
    const changedConn = before.gateway !== cfg.gateway || ['httpUrl', 'wsUrl', 'httpToken', 'wsToken', 'dir'].some((k) => before.snowluma[k] !== cfg.snowluma[k])
    // 换了模型：思考强度和「能不能看图」的探测结果都得重来，不然要等 10 分钟缓存过期
    const changedModel = before.model.provider !== cfg.model.provider || before.model.model !== cfg.model.model
      // 按聊天分的模型表变了也算（否则只改群默认、全局没动时缓存不会刷新）
      || JSON.stringify(before.chatModels) !== JSON.stringify(cfg.chatModels)
    if (changedModel) { clearReasoningCache(); clearVisionCache() }
    // 模型配置一改就直接同步到已有会话：平时要等对方发下一条消息才切，
    // 冷群几小时不动，主人看到的就是「配了没生效」。
    if (changedModel) {
      Promise.resolve().then(() => hub.syncAllModels?.()).then((r) => {
        if (r && r.applied) log.info(`[模型] 保存后同步了 ${r.applied} 个会话`)
      }).catch((error) => log.debug('保存后同步模型失败：', error.message))
    }
    if (changedConn || before.botQQ !== cfg.botQQ) gatewayState.wrongAccount = ''
    if (changedConn && onebot.state !== 'stopped') onebot.restart()
    // 人设配置变了（全局 current / 分群分流表 / 群·私聊默认）：受影响的会话立刻重置。
    // 旧历史里的人设块清不掉，模型每轮花上万 token 仲裁「我到底是谁」（P0-5 同根因）。
    // agentFor 的 hook 下一轮也会兜底，这里提前到保存动作本身，冷群不用等消息进来。
    const personaChanged = JSON.stringify(before.persona || {}) !== JSON.stringify(cfg.persona || {})
    if (personaChanged) {
      let reset = 0
      try {
        for (const [chatId, entry] of Object.entries(hub.sessions() || {})) {
          if (!entry.personaId) continue
          const want = personaIdFor({ kind: chatId.startsWith('group:') ? 'group' : chatId.startsWith('private:') ? 'private' : 'system', groupId: chatId.slice(6), userId: chatId.slice(8) }, cfg)
          if (want && entry.personaId !== want) { hub.resetChat(chatId); reset++ }
        }
      } catch (error) {
        log.debug('人设配置变更后重置会话出错：', error.message)
      }
      if (reset) log.info(`[人设] 配置变更，重置了 ${reset} 个会话`)
    }
    if (!before.enabled && cfg.enabled) setTimeout(safe(watchdog, '看门狗'), 100)
    if (before.enabled && !cfg.enabled) onebot.stop()
    log.info(`设置已保存｜总开关 ${cfg.enabled ? '开' : '关'}｜试运行 ${cfg.dryRun ? '开' : '关'}`)
    await getMods().sync().catch(() => {})
    if (pw && !pw.ok) return { ...(await overview()), ok: false, message: '其他设置保存了，但控制台密码没改：' + pw.message }
    return { ...(await overview()), message: '保存好了' + (pw ? '，' + pw.message : '') }
  })

  route('/sessions/reset', async () => {
    const n = hub.resetSessions()
    return { ok: true, message: n ? `归档了 ${n} 个会话，下一条消息起她会重新开始` : '本来就没有会话' }
  })

  // 面板「按聊天换人设」用：把机器人见过的群和私聊列出来，直接选，不用手打号码
  route('/panel/chats', async () => {
    try {
      const list = typeof hub.knownChats === 'function' ? hub.knownChats() : []
      return { ok: true, chats: list }
    } catch (error) {
      return { ok: false, chats: [], error: error.message }
    }
  })
}
