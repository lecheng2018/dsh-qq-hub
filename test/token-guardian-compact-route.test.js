// 回归：面板「现在压一次」点了没反应（2026-11-04 主人反馈，截图里红字「要先说压缩哪个聊天」）。
//
// 根因：面板的 call(p, body) 带第二个参数时发 POST 把参数放 body，
// 而后端只读 req.query.chatId —— 永远读不到，所以恒定回「要先说压缩哪个聊天」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')
const PANEL = readFileSync(join(ROOT, 'src/modules/token-guardian/panel.js'), 'utf8')

test('压缩路由同时接受 query 和 POST body 的 chatId', () => {
  assert.match(SRC, /req\?\.query\?\.chatId/, '要读 query（GET / 手输链接）')
  assert.match(SRC, /api\.core\.http\.body\(req\)/, 'query 没有再读 body（面板 call(p,body) 走 POST）')
})

test('面板按钮走 GET query，不再把 chatId 放 POST body', () => {
  assert.match(PANEL, /compact-now\?chatId=/, '按钮要把 chatId 拼进 query')
  assert.equal(
    /call\('\/token-guardian\/compact-now', \{ chatId/.test(PANEL), false,
    '不能再传第二个参数（那会发 POST，后端读不到）',
  )
})

test('摘要里能分清谁说的：chatlog 里 bot 的 who 是 bot 不是 self', () => {
  assert.match(SRC, /r\.who === 'bot' \|\| r\.who === 'self'/, 'who 判断要认 bot')
})

test('框架层给模块的 req 挂上 query（否则 req?.query?.x 全是 undefined）', () => {
  const HOST = readFileSync(join(ROOT, 'src/host.js'), 'utf8')
  assert.match(HOST, /req\.query = qs/, '模块 handler 收到的 req 没有 query，必须由框架挂上')
})

test('自动压缩不再拿 chatId 去问 chatOfSession（那里要 sessionId，恒返回空串）', () => {
  // 修前的写法：typeof chat === 'string' ? chat : (st.chatId || key) —— '' 也是 string，chatId 被置空
  assert.equal(
    /typeof chat === 'string' \? chat :/.test(SRC), false,
    '不能再让空串把 chatId 覆盖成空（那会让 compact 因「没有流水」直接跳过）',
  )
  assert.match(SRC, /let chatId = String\(st\.chatId \|\| key/, 'state 的 key 本身就是 chatId，直接用')
  assert.match(SRC, /\^\(group\|private\):\//, '只有非 chatId 形态才去反查')
})
