// 回归（P1-5）：token-guardian 摘要用聊天当前模型写（不是全局默认）。
// 群里指定模型 A 聊天，摘要却用模型 B 写，风格和事实口径不一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const TG = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')
const HUB = readFileSync(join(ROOT, 'src/chat/hub.js'), 'utf8')
const LLM = readFileSync(join(ROOT, 'src/core/llm.js'), 'utf8')

test('compact 先 resolveTarget(chat) 拿聊天当前模型', () => {
  assert.match(TG, /hub\.resolveTarget\?\.\(chat\)/, '要用 hub.resolveTarget')
  assert.match(TG, /\.\.\.askOpts/, 'provider/model 传给 api.ask')
})

test('hub 导出 resolveTarget', () => {
  assert.match(HUB, /    resolveTarget,/, '导出给模块用')
})

test('askModel 支持显式 provider/model 覆盖默认模型', () => {
  assert.match(LLM, /if \(o\.provider && o\.model\) \{ t\.provider = o\.provider; t\.model = o\.model \}/, '显式指定优先')
})
