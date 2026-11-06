// token-guardian 并发双压回归（2026-11-06，外部审查 #3 的钉子）：
// 30 秒轮询 + 面板手动按钮，同一个聊天两个压缩同时跑就是双 resetChat 双摘要。
// per-chatId 锁必须：重复请求拒绝、失败放锁、不同聊天互不挡。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const TG = readFileSync(new URL('../src/modules/token-guardian/index.js', import.meta.url), 'utf8')

test('锁结构：per-chatId 集合 + 入口包裹 + finally 放锁', () => {
  assert.match(TG, /const compactBusy = new Set\(\)/)
  assert.match(TG, /if \(compactBusy\.has\(chatId\)\)/, '重复请求先拒绝')
  assert.match(TG, /return await doCompact\(sessionKey, chat, meta\)/, '真正逻辑在内层函数')
  assert.match(TG, /finally \{[\s\S]{0,80}compactBusy\.delete\(chatId\)/, '异常也要放锁')
})

test('拒绝文案带 busy 标记（面板能区分「没压成」和「正在压」）', () => {
  assert.match(TG, /reason: 'busy'/)
})

test('摘要写回 chatlog 前置条件：只在 resetChat 成功后（双保险路径不污染流水）', () => {
  const logIdx = TG.indexOf('hub.logChat(chatId')
  const resetIdx = TG.indexOf('if (!resetOk) {')
  assert.ok(logIdx > resetIdx > 0, 'logChat 在 no-reset 分支之后')
})
