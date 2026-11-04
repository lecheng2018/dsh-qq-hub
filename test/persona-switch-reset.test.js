// 回归：切人设后旧会话里残留旧人设块，模型逐条仲裁新旧人设思考暴涨（P0-5）。
// 机制：createSession 记 personaId；agentFor 发现 entry.personaId 与当前
// personaIdFor(chat) 不一致就 resetChat 开新会话；覆盖块文案改硬仲裁（旧段落作废）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const HUB = readFileSync(join(ROOT, 'src/chat/hub.js'), 'utf8')
const HOST = readFileSync(join(ROOT, 'src/host.js'), 'utf8')
const PERSONAS = readFileSync(join(ROOT, 'src/persona/personas.js'), 'utf8')

test('createSession 记下建会话时生效的人设', () => {
  assert.match(HUB, /personaId: personaIdFor\(chat, getConfig\(\)\)/, 'sessions.json 里要有 personaId 字段')
})

test('人设变了就 resetChat 开新会话（老会话没记 personaId 不触发）', () => {
  assert.match(HUB, /entry\.personaId && entry\.personaId !== wantPersona/, '要比较人设')
  assert.match(HUB, /resetChat\(chat\.chatId\)/, '不一致要清场')
  assert.match(HUB, /!entry\.personaId \|\| entry\.personaId === wantPersona/, '老会话没记 personaId 时沿用，不误清')
})

test('覆盖块改成硬仲裁：旧人设段落直接作废，不要逐条仲裁', () => {
  assert.match(HOST, /那是换人设之前的旧人设，全部作废/, '文案要明确作废旧块')
  assert.doesNotMatch(HOST, /前面若出现别的性格描述，一律以这里为准/, '旧的软仲裁文案要去掉')
})
