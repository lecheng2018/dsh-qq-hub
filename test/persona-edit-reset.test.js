// 回归（P1-4）：面板里编辑人设正文后，正在用它的会话要重置。
// 静态前缀 {{qq_hub_persona}} 建会话时固化，光改文件旧会话拿不到新正文；
// 不重置的话新旧两段人设在历史里打架（与 P0-5 切人设同根因）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// host.js 分层拆分后：人格路由在 panel/routes-persona.js，/save 在 panel/routes-config.js
const HOST = readFileSync(join(ROOT, 'src/host/panel/routes-persona.js'), 'utf8')
const SAVE = readFileSync(join(ROOT, 'src/host/panel/routes-config.js'), 'utf8')
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

test('/persona/use 切换人设后立刻重置用旧全局人设的会话', () => {
  assert.match(HOST, /route\('\/persona\/use'[^]*?personaChanged|route\('\/persona\/use'[^]*?resetChat\(chatId\)/s, 'use 路由里要重置会话')
  const seg = HOST.slice(HOST.indexOf("route('/persona/use'"), HOST.indexOf("route('/persona/polish'"))
  assert.match(seg, /hub\.resetChat\(chatId\)/, 'use 路由内 reset')
})

test('/save 改人设配置（分流表/全局）后重置受影响会话', () => {
  const seg = SAVE.slice(SAVE.indexOf("route('/save'"), SAVE.indexOf("route('/save'", SAVE.indexOf("route('/save'") + 10))
  assert.match(seg, /personaChanged/, '比对 persona 前后差异')
  assert.match(seg, /personaIdFor/, '算出各会话当前该用哪张卡')
  assert.match(seg, /hub\.resetChat\(chatId\)/, '变了就重置')
})

test('agentFor 对没记 personaId 的老会话补基线不误重置', () => {
  assert.match(HUB, /entry && !entry\.personaId && wantPersona/, '空 personaId 补记')
  assert.match(HUB, /entry\.personaId = wantPersona/, '补记当前值')
})
