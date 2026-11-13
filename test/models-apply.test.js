// 回归：面板配的模型要能立刻应用到已有会话（2026-11-04 主人反馈「都要我去会话那里换」）。
//
// 原来的机制：只在对方发下一条消息时（ensureSession 里比对 m.chats[chatId].model）
// 才把配置同步到会话。冷群可能几小时不动，主人看到的就是「配了没生效」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CORE = readFileSync(join(ROOT, 'src/host/modular-core.js'), 'utf8')
// host.js 分层拆分后：/save 的模型联动在 panel/routes-config.js，/models/apply 路由在 panel/routes-misc.js
const HOST = readFileSync(join(ROOT, 'src/host/panel/routes-config.js'), 'utf8')
const MODELS = readFileSync(join(ROOT, 'src/host/panel/routes-misc.js'), 'utf8')
const CLIENT = readFileSync(join(ROOT, 'client/client.js'), 'utf8')

test('当前核心暴露 syncAllModels，能遍历所有已有会话切模型', () => {
  assert.match(CORE, /async function syncAllModels\(\)/, '要有这个函数')
  assert.match(CORE, /Object\.entries\(registry\.snapshot\(\)\)/, '要遍历当前会话映射')
  assert.match(CORE, /syncAllModels,\s*\n/, '要导出给 host 用')
})

test('切不动的会话要清映射（否则永远卡在那）', () => {
  assert.match(CORE, /registry\.forget\(chatId\)/, '失效会话要删掉，让下次按新配置重建')
  assert.match(CORE, /dropped/, '要有 dropped 计数')
})

test('保存模型配置后自动同步（不用主人手动点）', () => {
  assert.match(HOST, /if \(changedModel\) \{[\s\S]{0,200}syncAllModels/, '保存时触发')
  assert.match(HOST, /JSON\.stringify\(before\.chatModels\) !== JSON\.stringify\(cfg\.chatModels\)/, '按聊天的模型表变了也算改模型')
})

test('面板有「立刻应用到所有会话」按钮和路由', () => {
  assert.match(MODELS, /route\('\/models\/apply'/, '要有路由')
  assert.match(CLIENT, /立刻应用到所有会话/, '要有按钮')
  assert.match(CLIENT, /models\/apply/, '按钮要调路由')
})

test('失败时消息不能还说「都和配置一致」', () => {
  assert.match(MODELS, /r\.failed \? |if \(r\.failed\) parts\.push/, '要如实报失败数')
})
