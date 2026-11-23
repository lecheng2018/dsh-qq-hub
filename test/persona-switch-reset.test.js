// 回归：切人设后旧会话里残留旧人设块，模型逐条仲裁新旧人设思考暴涨（P0-5）。
// 机制：createSession 记 personaId；agentFor 发现 entry.personaId 与当前
// personaIdFor(chat) 不一致就 resetChat 开新会话。
// 1.3.44 起不再有「覆盖块」这回事：按聊天换人设改成在 agent 作用域里遮蔽
// {{qq_hub_persona}}，提示词里只会有一套人设，也就不需要「旧段落作废」这种仲裁文案了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CORE = readFileSync(join(ROOT, 'src/host/modular-core.js'), 'utf8')
const HOST = readFileSync(join(ROOT, 'src/host.js'), 'utf8')
const PERSONAS = readFileSync(join(ROOT, 'src/persona/personas.js'), 'utf8')

test('当前会话注册表记下建会话时生效的人设（含正文指纹）', () => {
  // 2026-11-23：只记 personaId 会漏掉「卡没换、正文改了」——那种情况旧正文早就
  // 烧进系统提示词了，只看 id 永远等不到重建。记 id + hash 才能判出「同一张卡的旧版本」。
  assert.match(CORE, /const want = currentPersonaTarget\(chatKey\)/, '建会话前先取目标（id + 指纹）')
  assert.match(CORE, /sessionPersonas\.set\(chatKey, \{ sessionId: String\(created\.sessionId\), personaId: want\.id, personaHash: want\.hash \}\)/)
  assert.match(CORE, /activeChatBySessionId\.set\(String\(created\.sessionId\), chatKey\)/, '建完会话立刻登记反查，装配期才能按对卡渲染')
  assert.match(CORE, /personaHashAssumed/, '老映射按当前指纹做基线时要有 assumed 标记')
})

test('人设变了（换卡或改正文）就 resetChat 开新会话', () => {
  assert.match(CORE, /const personaStale = \(persona, sessionId, want\) =>/, '守卫收敛成一个口径')
  assert.match(CORE, /String\(persona\.personaId \|\| ''\) !== want\.id/, '换卡要判出来')
  assert.match(CORE, /String\(persona\.personaHash \|\| ''\) !== want\.hash/, '改正文也要判出来')
  assert.match(CORE, /if \(!personaStale\(persona, entry\.sessionId, want\)\)/, '过期就往下走重置')
  assert.match(CORE, /resetChat\(chatKey\)/, '不一致要清场')
  assert.match(CORE, /const personaId = entry\.personaId \|\| currentPersona\(chatKey\)/, '老会话没记 personaId 时使用当前基线，不误清')
})

test('不再往提示词里追加「专用人设」覆盖块，改成同作用域遮蔽变量', () => {
  assert.ok(!HOST.includes('那是换人设之前的旧人设，全部作废'), '覆盖块文案不需要了（块本身已经不生成）')
  assert.ok(!HOST.includes('【本聊天专用人设：'), 'host 不再注入那块')
  assert.match(CORE, /sp\.variable\('qq_hub_persona'/, '改成在 agent 作用域里遮蔽人设变量')
  assert.doesNotMatch(HOST, /前面若出现别的性格描述，一律以这里为准/, '旧的软仲裁文案同样不要回来')
})
