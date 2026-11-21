// 回归：面板「现在压一次」点了没反应（2026-11-04 主人反馈，截图里红字「要先说压缩哪个聊天」）。
//
// 根因：面板的 call(p, body) 带第二个参数时发 POST 把参数放 body，
// 而后端只读 req.query.chatId —— 永远读不到，所以恒定回「要先说压缩哪个聊天」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { speakerLabel } from '../src/modules/token-guardian/summary-format.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')
const PANEL = readFileSync(join(ROOT, 'src/modules/token-guardian/panel.js'), 'utf8')

test('压缩路由同时接受 query 和 POST body 的 chatId', () => {
  assert.match(SRC, /req\?\.query\?\.chatId/, '要读 query（GET / 手输链接）')
  assert.match(SRC, /api\.core\.http\.body\(req\)/, 'query 没有再读 body（面板 call(p,body) 走 POST）')
})

test('面板按钮走 POST 把 chatId 放 body（guard 对写接口有 GET 方法约束）', () => {
  // 审计 S04：压缩是写接口（触发模型调用＝计费），进了 SIDE_EFFECT_PATHS，
  // 带 query 的 GET 会在进 handler 之前被 guard 405 掉。所以面板必须发 POST。
  assert.match(
    PANEL,
    /requestSafe\('\/compact-now', '\/token-guardian\/compact-now', \{ chatId \}\)/,
    '压缩按钮要 POST，chatId 放 body',
  )
  assert.match(
    PANEL,
    /requestSafe\('\/reset-usage', '\/token-guardian\/reset-usage', \{ chatId \}\)/,
    '重置用量按钮同样要走 POST',
  )
  // 不能再退回「把 chatId 拼进 query 的 GET」——那正是被 405 的形态
  assert.equal(
    /compact-now\?chatId=/.test(PANEL), false,
    '不能再用 compact-now?chatId= 的 GET 形态（会被 guard 405）',
  )
  // 只读的摘要仍走 GET，不受方法约束影响
  assert.match(PANEL, /requestSafe\('\/summary' \+ q, '\/token-guardian\/summary\?chatId='/, '摘要仍走 GET')
})

test('摘要里能分清谁说的：她自己叫「你」，其他人用真实群名片', () => {
  // chatlog 里 bot 的 who 是 'bot' 不是 'self'：判错了摘要里全是「对方」，分不清哪句是她说的
  assert.equal(speakerLabel({ who: 'bot' }), '你')
  assert.equal(speakerLabel({ who: 'self' }), '你')
  // 群聊里多人：2026-11-17 之前一律塌缩成「对方」，八个人糊成一个，
  // 下一轮就把 A 的经历安到 B 头上（issue #2366 同源）
  assert.equal(speakerLabel({ who: '洛书' }), '洛书')
  assert.notEqual(speakerLabel({ who: '洛书' }), speakerLabel({ who: '落叶' }))
  // 只有 QQ 号没有名片时没有可读性，退回「对方」
  assert.equal(speakerLabel({ who: '3380533775' }), '对方')
  assert.equal(speakerLabel({}), '对方')
  // 名片里的换行/冒号不能把「名字：正文」的行结构弄垮
  assert.doesNotMatch(speakerLabel({ who: 'a\nb:c：d' }), /[\n:：]/)
  // 原文确实用 speakerLabel 拼每一行
  assert.match(SRC, /rows\.push\(`\$\{speakerLabel\(r\)\}：\$\{r\.text\}`\)/)
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
