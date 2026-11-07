// 宿主自带的工作区删除在界面上，脚本化维护没有门路：1.3.41 改回共用工作区后，
// 之前按聊天建出来的「QQ Hub」子工作区需要能清掉，所以补 /workspaces/list 与 /workspaces/delete。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// host.js 分层拆分后：工作区路由在 panel/routes-config.js（断言逐字保留）
const HOST = readFileSync(join(ROOT, 'src/host/panel/routes-config.js'), 'utf8')
const HUB = readFileSync(join(ROOT, 'src/chat/hub.js'), 'utf8')

function blockOf(src, marker, size = 2200) {
  const i = src.indexOf(marker)
  assert.ok(i >= 0, '找不到 ' + marker)
  return src.slice(i, i + size)
}

test('有列出工作区的接口', () => {
  const b = blockOf(HOST, "route('/workspaces/list'")
  assert.match(b, /reg\.list\(\)/, '要读宿主注册表')
  assert.match(b, /sessions: \(w\.sessionIds \|\| \[\]\)\.length/, '要带会话条数，便于判断哪个能删')
})

test('删工作区前先把还住在那里的 QQ 会话收掉', () => {
  const b = blockOf(HOST, "route('/workspaces/delete'", 2600)
  assert.match(b, /hub\.resetChat\(chatId\)/, '先 resetChat，否则删完工作区会话没落脚点')
  assert.ok(b.indexOf('resetChat') < b.indexOf('reg.delete(id)'), 'resetChat 必须排在 delete 之前')
  assert.match(b, /reg\.delete\(id\)/)
})

test('没给 id 时不乱删，返回人话', () => {
  const b = blockOf(HOST, "route('/workspaces/delete'", 1200)
  assert.match(b, /没说要删哪个工作区/)
})

test('resetChat 仍然从 hub 导出（删工作区接口依赖它）', () => {
  assert.match(HUB, /\n\s+resetChat,/)
})
