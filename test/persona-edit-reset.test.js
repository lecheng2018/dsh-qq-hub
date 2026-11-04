// 回归（P1-4）：面板里编辑人设正文后，正在用它的会话要重置。
// 静态前缀 {{qq_hub_persona}} 建会话时固化，光改文件旧会话拿不到新正文；
// 不重置的话新旧两段人设在历史里打架（与 P0-5 切人设同根因）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const HOST = readFileSync(join(ROOT, 'src/host.js'), 'utf8')
const HUB = readFileSync(join(ROOT, 'src/chat/hub.js'), 'utf8')

test('/persona/save 后重置所有正在用该人设的会话', () => {
  assert.match(HOST, /entry\.personaId === b\.id/, '按 personaId 找会话')
  assert.match(HOST, /hub\.resetChat\(chatId\)/, '重置会话')
  assert.match(HOST, /reset > 0 [^]*个正在用的会话已重置|个正在用的会话已重置/, '返回消息说明重置了几个')
})

test('hub 导出 sessions() 与 resetChat（host 能拿到）', () => {
  assert.match(HUB, /sessions: \(\) => map\(\)\.chats/, 'sessions 导出')
  assert.match(HUB, /    resetChat,/, 'resetChat 导出')
})
