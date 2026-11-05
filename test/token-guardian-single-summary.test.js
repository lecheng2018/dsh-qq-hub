// 回归（P0-6）：摘要文本一变 DSH 就追加快照进历史，旧块不删。
// 所以 compact 必须先 resetChat 成功才更新摘要；reset 失败保持旧摘要（no-reset），
// 避免同一会话历史里堆 v1/v2/v3 多份「更早聊天的摘要」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')

test('先重置会话、后落摘要（reset 成功才换摘要文本）', () => {
  const compactIdx = SRC.indexOf('async function compact')
  const resetIdx = SRC.indexOf('hub.resetChat(chatId)', compactIdx)
  const summaryIdx = SRC.indexOf('summaries[sessionKey] = { text: body', compactIdx)
  assert.ok(resetIdx > 0 && summaryIdx > resetIdx, 'resetChat 要发生在写 summaries 之前')
})

test('reset 失败不更新摘要（防历史堆多份快照），返回 no-reset', () => {
  assert.match(SRC, /if \(!resetOk\) \{[\s\S]{0,400}no-reset/, '要有 no-reset 分支')
  // 1.3.46 起失败信息顺带说明会短冷却重试；「防止历史堆多份摘要」的口径仍在
  assert.match(SRC, /摘要保持原样/, '失败原因要写清楚')
})

test('state/summaries 两处 key 注释统一为 chatId', () => {
  assert.match(SRC, /chatId → \{ chars, lastAt/, 'state 注释要写 chatId')
  assert.match(SRC, /chatId → \{ text, at \}/, 'summaries 注释要写 chatId')
})
