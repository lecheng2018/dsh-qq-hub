// QQ Hub · 面板路由：扩展模块管理 + 模拟测试（host.js 分层拆出）
//
// 模拟测试：不用上 QQ 就能试模块。发出去的消息只截下来给面板看，不真发
// （模块直接调 api.onebot(...) 的操作不在此列，是真的会执行的）

import { join } from 'node:path'
import { parseCommand } from '../../chat/commands.js'
import { API_VERSION } from '../../core/modules.js'

export function registerModulesRoutes({
  route, readBody, query, send,
  getConfig,
  hub, mods, openFolder,
}) {
  // 模块（面板「扩展」页）
  route('/modules', async () => ({ ok: true, dir: mods.dir(), safeMode: getConfig().safeMode, apiVersion: API_VERSION, list: mods.status(), prompt: mods.promptFor('') }))
  route('/modules/reload', async (req) => {
    const id = String((await readBody(req)).id || '')
    if (!id) { await mods.sync(); return { ok: true, message: '检查过了', list: mods.status() } }
    const m = await mods.reload(id)
    return { ok: Boolean(m && !m.error), message: m?.error ? '加载失败：' + m.error : '重新加载好了', list: mods.status() }
  })
  route('/modules/create', async (req) => {
    const b = await readBody(req)
    const r = mods.create(String(b.id || '').trim(), String(b.name || '').trim())
    if (r.ok) await mods.sync()
    return { ...r, list: mods.status(), prompt: r.ok ? mods.promptFor(String(b.id).trim()) : '' }
  })
  route('/modules/fork', async (req) => {
    const id = String((await readBody(req)).id || '')
    const r = mods.fork(id)
    if (r.ok) await mods.sync()
    return { ...r, list: mods.status(), prompt: r.ok ? mods.promptFor(id) : '' }
  })
  route('/modules/prompt', async (req) => ({ ok: true, prompt: mods.promptFor(String(query(req).id || '')) }))
  route('/modules/open', async (req) => {
    const id = String(query(req).id || '')
    return openFolder(id ? join(mods.dir(), id) : mods.dir())
  })
  // 没有文字的（语音条、表情、图片）显示发送备注，比如「[语音·edge] 早呀」
  const sentLines = (sent) => sent.map((s) => ({ chatId: s.chatId, note: s.note, text: s.message.some((seg) => seg.type === 'text') ? s.message.map((seg) => (seg.type === 'text' ? seg.data.text : seg.type === 'reply' ? '' : `[${seg.type}]`)).join('') : s.note }))
  const simChat = (b) => {
    const owner = b.as !== 'other'
    const userId = owner ? getConfig().ownerQQ : '10001'
    const group = b.kind === 'group'
    const groupId = String(b.groupId || getConfig().allow.groups[0] || '10002')
    return { owner, userId, chat: group ? { chatId: `group:${groupId}`, kind: 'group', groupId, userId } : { chatId: `private:${userId}`, kind: 'private', userId } }
  }
  route('/modules/simulate', async (req) => {
    const b = await readBody(req)
    const { owner, userId, chat } = simChat(b)
    const text = String(b.text || '')
    const steps = []
    const msg = { ...chat, nickname: owner ? getConfig().ownerName || '主人' : '路人', role: '', messageId: 'sim', text, mentioned: Boolean(b.mentioned), replyId: '', images: [], stickers: [], records: [], forwards: [], raw: { simulated: true } }
    const { sent } = await hub.capture(async () => {
      if (text) {
        const cmd = owner && /^\s*[/／]/.test(text) ? parseCommand(text, mods.commands()) : null
        if (cmd && cmd.ext) {
          const reply = String((await cmd.ext.run(cmd.arg, msg)) ?? '')
          steps.push(`命令 /${cmd.name}（模块「${cmd.ext.module}」）回：${reply || '（空）'}`)
          if (reply) await hub.sendText(chat.chatId, reply)
        } else if (cmd) {
          steps.push(`这是内置命令 /${cmd.name}，模拟里不执行（会真的改设置）`)
        } else if (await mods.claim('message', msg)) {
          steps.push('有模块接管了这条消息，她不会再回')
        } else {
          steps.push('没有模块接管，这条会交给她（模拟里不会真的让她想）')
        }
      }
      if (b.reply) {
        const items = await hub.deliver(chat.chatId, String(b.reply), { simulate: true })
        steps.push(items ? `她的回复经过模块改写后拆成 ${items.length} 条` : '她的回复被模块拦下了，不发')
      }
    })
    return { ok: true, steps, sent: sentLines(sent) }
  })
  route('/modules/tools', async (req) => {
    const q = query(req)
    const { owner, chat } = simChat(q)
    const level = owner && chat.kind === 'private' ? 'full' : 'social'
    return { ok: true, level, list: mods.buildTools({ chat, level, sessionId: 'sim' }).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }
  })
  route('/modules/tool', async (req) => {
    const b = await readBody(req)
    const { owner, userId, chat } = simChat(b)
    const level = owner && chat.kind === 'private' ? 'full' : 'social'
    const tool = mods.buildTools({ chat, level, sessionId: 'sim' }).find((t) => t.name === b.name)
    if (!tool) return { ok: false, message: `这个场合没有 ${b.name} 这个工具` }
    hub.simulateTurn('sim', [userId])
    const { result, sent } = await hub.capture(() => tool.execute(b.args && typeof b.args === 'object' ? b.args : {}, {}))
    return { ok: true, result, sent: sentLines(sent) }
  })
  route('/modules/panel', async (req, res) => {
    const src = mods.panelSource(String(query(req).id || ''))
    if (src === null) return send(res, 404, '')
    send(res, 200, src, 'text/javascript; charset=utf-8')
  })
}
